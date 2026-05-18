import { createClient, RedisClientType } from "ioredis";
import pg from "pg";
import express from "express";
import pino from "pino";

// ── Environment ──────────────────────────────────────────────────────

const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "http://localhost:3000";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://paperclip:paperclip@localhost:5432/paperclip";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const HEARTBEAT_PORT = parseInt(process.env.HEARTBEAT_PORT || "3001", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "10000", 10);

const logger = pino({ name: "heartbeat-engine", level: process.env.LOG_LEVEL || "info" });

// ── Database ─────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function dbReady(): Promise<boolean> {
  try {
    const res = await pool.query("SELECT 1 AS ok");
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

// ── Redis ────────────────────────────────────────────────────────────

let redis: RedisClientType | null = null;

async function redisConnect(): Promise<void> {
  redis = createClient({ url: REDIS_URL, lazyConnect: true });
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis_error"));
  await redis.connect();
  logger.info({ url: REDIS_URL }, "redis_connected");
}

async function redisReady(): Promise<boolean> {
  if (!redis) return false;
  try {
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

// ── Paperclip API ────────────────────────────────────────────────────

async function notifyReady(): Promise<boolean> {
  if (!PAPERCLIP_API_KEY || !PAPERCLIP_AGENT_ID) {
    logger.info("no_api_credentials_skipping_ready_notify");
    return true;
  }
  try {
    const res = await fetch(`${PAPERCLIP_API_URL}/api/agents/${PAPERCLIP_AGENT_ID}/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
        "Content-Type": "application/json",
        "X-Paperclip-Company-Id": PAPERCLIP_COMPANY_ID,
      },
      body: JSON.stringify({ status: "ready", timestamp: new Date().toISOString() }),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err }, "ready_notify_failed");
    return false;
  }
}

// ── Heartbeat loop ───────────────────────────────────────────────────

async function runHeartbeatCycle(): Promise<void> {
  const dbOk = await dbReady();
  const rdsOk = await redisReady();

  if (!dbOk || !rdsOk) {
    logger.warn({ db_ok: dbOk, redis_ok: rdsOk }, "dependencies_not_ready_skipping_cycle");
    return;
  }

  try {
    // Claim pending heartbeats from Redis sorted set
    const now = Date.now();
    const claimed = await redis!.zrangebyscore(
      "heartbeat:schedule",
      0,
      now,
      "LIMIT",
      0,
      10,
    );

    if (claimed.length === 0) {
      logger.debug("no_pending_heartbeats");
      return;
    }

    // Remove claimed items and push to processing stream
    await redis!.zrem("heartbeat:schedule", ...claimed);
    const pipeline = redis!.pipeline();
    for (const entry of claimed) {
      pipeline.xadd("heartbeat:processing", "*", "payload", entry);
    }
    await pipeline.exec();

    logger.info({ claimed: claimed.length }, "heartbeats_claimed");
  } catch (err) {
    logger.error({ err }, "heartbeat_cycle_error");
  }
}

// ── Health server ────────────────────────────────────────────────────

function startHealthServer(): void {
  const app = express();

  app.get("/health", async (_req, res) => {
    const [dbOk, rdsOk] = await Promise.all([dbReady(), redisReady()]);
    const healthy = dbOk && rdsOk;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "unhealthy",
      checks: {
        database: dbOk ? "ok" : "fail",
        redis: rdsOk ? "ok" : "fail",
      },
      uptime: process.uptime(),
    });
  });

  app.listen(HEARTBEAT_PORT, () => {
    logger.info({ port: HEARTBEAT_PORT }, "health_server_started");
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info(
    {
      agent_id: PAPERCLIP_AGENT_ID || "(unset)",
      company_id: PAPERCLIP_COMPANY_ID || "(unset)",
      api_url: PAPERCLIP_API_URL,
      interval_ms: HEARTBEAT_INTERVAL_MS,
    },
    "heartbeat_engine_starting",
  );

  // Connect to Redis
  try {
    await redisConnect();
  } catch (err) {
    logger.fatal({ err }, "redis_connect_failed");
    process.exit(1);
  }

  // Start health endpoint
  startHealthServer();

  // Wait for DB to be reachable before notifying ready
  for (let i = 0; i < 30; i++) {
    if (await dbReady()) break;
    logger.info("waiting_for_database");
    await sleep(2000);
  }

  if (!(await dbReady())) {
    logger.error("database_not_available_starting_anyway");
  }

  await notifyReady();

  // Heartbeat loop
  logger.info({ interval_ms: HEARTBEAT_INTERVAL_MS }, "heartbeat_loop_starting");
  setInterval(runHeartbeatCycle, HEARTBEAT_INTERVAL_MS);

  // Run first cycle immediately
  runHeartbeatCycle();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("sigterm_received_shutting_down");
  if (redis) await redis.quit();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("sigint_received_shutting_down");
  if (redis) await redis.quit();
  await pool.end();
  process.exit(0);
});

main().catch((err) => {
  logger.fatal({ err }, "heartbeat_engine_fatal");
  process.exit(1);
});
