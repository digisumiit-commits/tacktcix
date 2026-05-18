import Redis from 'ioredis';
import { Task, priorityScore, SLA_BOOST_MAX, BLOCKED_PENALTY, OVERRIDE_BOUND, SLA_WINDOW_MS } from '../types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL);
  }
  return redis;
}

const QUEUE_KEY = 'task:priority:queue';
const OVERRIDES_KEY = 'task:priority:overrides';

export async function enqueueTask(task: Task): Promise<void> {
  const r = getRedis();
  const score = await computeEffectiveScore(task);
  await r.zadd(QUEUE_KEY, score, task.id);
}

export async function removeFromQueue(taskId: string): Promise<void> {
  const r = getRedis();
  await Promise.all([
    r.zrem(QUEUE_KEY, taskId),
    r.hdel(OVERRIDES_KEY, taskId),
  ]);
}

export async function getQueueLength(): Promise<number> {
  const r = getRedis();
  return r.zcard(QUEUE_KEY);
}

export async function getQueueTasks(limit: number = 20): Promise<string[]> {
  const r = getRedis();
  return r.zrevrange(QUEUE_KEY, 0, limit - 1);
}

// ── Dynamic Reprioritization ────────────────────────────

/**
 * Compute the SLA urgency boost for a task.
 * Returns a value between 0 and SLA_BOOST_MAX, ramping up linearly
 * as the deadline approaches within the SLA_WINDOW_MS window.
 */
export function calculateSlaBoost(task: Task): number {
  if (!task.slaDeadline) return 0;

  const now = Date.now();
  const deadline = task.slaDeadline.getTime();
  const remaining = deadline - now;

  if (remaining <= 0) {
    // Past deadline — maximum boost
    return SLA_BOOST_MAX;
  }

  if (remaining > SLA_WINDOW_MS) {
    // Outside the urgency window — no boost yet
    return 0;
  }

  // Linear ramp-up as deadline approaches
  const urgency = 1 - remaining / SLA_WINDOW_MS;
  return Math.round(SLA_BOOST_MAX * urgency);
}

/**
 * Compute the effective score for a task considering all dynamic factors:
 * - Base priority + age (from priorityScore)
 * + SLA deadline urgency boost
 * - Blocked penalty (if task.status === 'blocked')
 * + Manual override bump (if set)
 */
export async function computeEffectiveScore(
  task: Task,
  overrideBump?: number
): Promise<number> {
  const base = priorityScore(task.priority, task.createdAt);
  const slaBoost = calculateSlaBoost(task);
  const blockedPenalty = task.status === 'blocked' ? BLOCKED_PENALTY : 0;

  let manualBump: number;
  if (overrideBump !== undefined) {
    manualBump = overrideBump;
  } else {
    manualBump = await getPriorityOverride(task.id);
  }

  return base + slaBoost - blockedPenalty + manualBump;
}

/**
 * Recompute the score for a queued task and update its position in the
 * sorted set. Should be called when any reprioritization-relevant state
 * changes (status, SLA deadline, dependency resolution, etc.).
 */
export async function reprioritizeTask(task: Task): Promise<void> {
  const r = getRedis();
  const score = await computeEffectiveScore(task);
  await r.zadd(QUEUE_KEY, score, task.id);
}

// ── Manual Priority Overrides ───────────────────────────

/**
 * Set a manual priority override bump for a task. Positive values increase
 * priority; negative values decrease it. Bounded to ±OVERRIDE_BOUND.
 * Returns the clamped bump value that was stored.
 */
export async function setPriorityOverride(
  taskId: string,
  bump: number
): Promise<number> {
  const clamped = Math.max(-OVERRIDE_BOUND, Math.min(OVERRIDE_BOUND, bump));
  const r = getRedis();
  await r.hset(OVERRIDES_KEY, taskId, String(clamped));
  return clamped;
}

/**
 * Remove a manual priority override for a task.
 */
export async function clearPriorityOverride(taskId: string): Promise<void> {
  const r = getRedis();
  await r.hdel(OVERRIDES_KEY, taskId);
}

/**
 * Get the current manual override bump for a task. Returns 0 if none set.
 */
export async function getPriorityOverride(taskId: string): Promise<number> {
  const r = getRedis();
  const raw = await r.hget(OVERRIDES_KEY, taskId);
  if (raw === null || raw === undefined) return 0;
  return Number(raw);
}

/**
 * List all manual priority overrides currently stored.
 */
export async function listPriorityOverrides(): Promise<
  { taskId: string; bump: number }[]
> {
  const r = getRedis();
  const all = await r.hgetall(OVERRIDES_KEY);
  return Object.entries(all).map(([taskId, bump]) => ({
    taskId,
    bump: Number(bump),
  }));
}
