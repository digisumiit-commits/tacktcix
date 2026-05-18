"""PostgreSQL connection and schema management for metrics storage."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from dataclasses import dataclass

import psycopg2
import psycopg2.extras
import structlog

logger = structlog.get_logger(__name__)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS heartbeat_metrics (
    id              BIGSERIAL PRIMARY KEY,
    agent_id        VARCHAR(255) NOT NULL,
    worker_id       VARCHAR(255) NOT NULL DEFAULT '',
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scanned         INTEGER NOT NULL DEFAULT 0,
    failures        INTEGER NOT NULL DEFAULT 0,
    executed        INTEGER NOT NULL DEFAULT 0,
    sleep_interval_ms INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    status          VARCHAR(50) NOT NULL DEFAULT 'healthy',
    error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_hb_agent_time
    ON heartbeat_metrics (agent_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_hb_recorded
    ON heartbeat_metrics (recorded_at DESC);
"""


@dataclass
class HeartbeatRecord:
    agent_id: str
    worker_id: str
    scanned: int
    failures: int
    executed: int
    sleep_interval_ms: int
    duration_ms: int
    status: str = "healthy"
    error_message: str = ""


class MetricsDB:
    """Manages the PostgreSQL connection for heartbeat metrics storage."""

    def __init__(
        self,
        dsn: str | None = None,
        *,
        host: str | None = None,
        port: int | None = None,
        dbname: str | None = None,
        user: str | None = None,
        password: str | None = None,
    ) -> None:
        if dsn:
            self._dsn = dsn
        else:
            pg_host = host or os.environ.get("PG_HOST", "postgres")
            pg_port = port or int(os.environ.get("PG_PORT", "5432"))
            pg_db = dbname or os.environ.get("PG_DB") or os.environ.get("POSTGRES_DB", "paperclip")
            pg_user = user or os.environ.get("PG_USER") or os.environ.get("POSTGRES_USER", "paperclip")
            pg_pass = password or os.environ.get("PG_PASSWORD") or os.environ.get("POSTGRES_PASSWORD", "paperclip")
            self._dsn = (
                f"host={pg_host} port={pg_port} dbname={pg_db} "
                f"user={pg_user} password={pg_pass}"
            )
        self._conn: psycopg2.extensions.connection | None = None

    def connect(self) -> None:
        self._conn = psycopg2.connect(self._dsn)
        self._conn.autocommit = False
        self._ensure_schema()
        logger.info("metrics_db_connected")

    def _ensure_schema(self) -> None:
        with self._conn.cursor() as cur:
            cur.execute(SCHEMA_SQL)
        self._conn.commit()

    def insert_heartbeat(self, record: HeartbeatRecord) -> int:
        with self._conn.cursor() as cur:
            cur.execute(
                """INSERT INTO heartbeat_metrics
                   (agent_id, worker_id, scanned, failures, executed,
                    sleep_interval_ms, duration_ms, status, error_message)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                (
                    record.agent_id,
                    record.worker_id,
                    record.scanned,
                    record.failures,
                    record.executed,
                    record.sleep_interval_ms,
                    record.duration_ms,
                    record.status,
                    record.error_message,
                ),
            )
            row_id = cur.fetchone()[0]
        self._conn.commit()
        return row_id

    def get_agent_summary(self, since_minutes: int = 60) -> list[dict]:
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT
                     agent_id,
                     COUNT(*) AS cycles,
                     SUM(scanned) AS total_scanned,
                     SUM(failures) AS total_failures,
                     SUM(executed) AS total_executed,
                     AVG(sleep_interval_ms)::BIGINT AS avg_sleep_ms,
                     AVG(duration_ms)::BIGINT AS avg_duration_ms,
                     MAX(recorded_at) AS last_heartbeat,
                     MAX(status) FILTER (WHERE status != 'healthy') AS last_error_status
                   FROM heartbeat_metrics
                   WHERE recorded_at >= NOW() - INTERVAL '%s minutes'
                   GROUP BY agent_id
                   ORDER BY last_heartbeat DESC""",
                (since_minutes,),
            )
            return cur.fetchall()

    def get_recent_heartbeats(
        self, agent_id: str | None = None, limit: int = 100
    ) -> list[dict]:
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if agent_id:
                cur.execute(
                    """SELECT * FROM heartbeat_metrics
                       WHERE agent_id = %s
                       ORDER BY recorded_at DESC LIMIT %s""",
                    (agent_id, limit),
                )
            else:
                cur.execute(
                    """SELECT * FROM heartbeat_metrics
                       ORDER BY recorded_at DESC LIMIT %s""",
                    (limit,),
                )
            return cur.fetchall()

    def get_failure_rate(self, since_minutes: int = 60) -> float:
        with self._conn.cursor() as cur:
            cur.execute(
                """SELECT
                   CASE WHEN SUM(scanned) > 0
                     THEN SUM(failures)::FLOAT / SUM(scanned)
                     ELSE 0
                   END
                   FROM heartbeat_metrics
                   WHERE recorded_at >= NOW() - INTERVAL '%s minutes'""",
                (since_minutes,),
            )
            row = cur.fetchone()
            return row[0] if row else 0.0

    def get_sleep_trend(self, agent_id: str | None = None, limit: int = 50) -> list[dict]:
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if agent_id:
                cur.execute(
                    """SELECT recorded_at, sleep_interval_ms, agent_id
                       FROM heartbeat_metrics
                       WHERE agent_id = %s
                       ORDER BY recorded_at DESC LIMIT %s""",
                    (agent_id, limit),
                )
            else:
                cur.execute(
                    """SELECT recorded_at, sleep_interval_ms, agent_id
                       FROM heartbeat_metrics
                       ORDER BY recorded_at DESC LIMIT %s""",
                    (limit,),
                )
            return cur.fetchall()

    def close(self) -> None:
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def health(self) -> bool:
        if self._conn is None or self._conn.closed:
            return False
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT 1")
            return True
        except Exception:
            return False
