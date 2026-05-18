"""Heartbeat metrics collector and Prometheus exporter.

Tracks per-agent heartbeat cycle metrics:
- scanned: tasks scanned during the heartbeat
- failures: tasks that failed
- executed: tasks successfully executed
- sleep_interval_ms: sleep time between heartbeats
- duration_ms: total heartbeat cycle duration
- status: healthy / unhealthy / degraded
"""

from __future__ import annotations

import time
import threading
from collections import defaultdict
from dataclasses import dataclass, field

import structlog

from .db import MetricsDB, HeartbeatRecord

logger = structlog.get_logger(__name__)


@dataclass
class HeartbeatCycle:
    """Tracks a single agent's heartbeat cycle metrics."""

    agent_id: str
    worker_id: str = ""
    scanned: int = 0
    failures: int = 0
    executed: int = 0
    sleep_interval_ms: int = 0
    started_at: float = field(default_factory=time.time)
    status: str = "healthy"
    error_message: str = ""
    completed: bool = False

    @property
    def duration_ms(self) -> int:
        return int((time.time() - self.started_at) * 1000)

    def finish(self) -> HeartbeatRecord:
        self.completed = True
        return HeartbeatRecord(
            agent_id=self.agent_id,
            worker_id=self.worker_id,
            scanned=self.scanned,
            failures=self.failures,
            executed=self.executed,
            sleep_interval_ms=self.sleep_interval_ms,
            duration_ms=self.duration_ms,
            status=self.status,
            error_message=self.error_message,
        )


class HeartbeatMetricsCollector:
    """Collects and persists heartbeat metrics for all agents.

    Thread-safe. In-memory counters are reset after each flush to the database.
    """

    def __init__(self, db: MetricsDB, *, retention_days: int = 30) -> None:
        self._db = db
        self._retention_days = retention_days
        self._lock = threading.Lock()
        self._cycles: dict[str, HeartbeatCycle] = {}
        self._last_flush: float = 0.0
        self._flush_count: int = 0
        self._flush_errors: int = 0

        # Aggregate counters (cumulative since process start)
        self._total_scanned: int = 0
        self._total_failures: int = 0
        self._total_executed: int = 0
        self._total_cycles: int = 0

    # ── lifecycle ──────────────────────────────────────────────

    def start_cycle(self, agent_id: str, *, worker_id: str = "") -> HeartbeatCycle:
        """Begin tracking a new heartbeat cycle for the given agent."""
        with self._lock:
            cycle = HeartbeatCycle(agent_id=agent_id, worker_id=worker_id)
            self._cycles[agent_id] = cycle
        logger.debug("heartbeat_cycle_started", agent_id=agent_id)
        return cycle

    def end_cycle(
        self,
        agent_id: str,
        *,
        scanned: int = 0,
        failures: int = 0,
        executed: int = 0,
        sleep_interval_ms: int = 0,
        status: str = "healthy",
        error_message: str = "",
    ) -> HeartbeatRecord | None:
        """Complete a heartbeat cycle and persist to the database."""
        with self._lock:
            cycle = self._cycles.pop(agent_id, None)
            if cycle is None:
                logger.warning(
                    "heartbeat_end_no_active_cycle", agent_id=agent_id
                )
                return None

            cycle.scanned = scanned
            cycle.failures = failures
            cycle.executed = executed
            cycle.sleep_interval_ms = sleep_interval_ms
            cycle.status = status
            cycle.error_message = error_message
            record = cycle.finish()

            self._total_scanned += scanned
            self._total_failures += failures
            self._total_executed += executed
            self._total_cycles += 1

        try:
            self._db.insert_heartbeat(record)
            self._flush_count += 1
            self._last_flush = time.time()
        except Exception:
            logger.exception("heartbeat_db_insert_failed", agent_id=agent_id)
            self._flush_errors += 1
            return None

        logger.info(
            "heartbeat_cycle_recorded",
            agent_id=agent_id,
            scanned=scanned,
            failures=failures,
            executed=executed,
            sleep_interval_ms=sleep_interval_ms,
            duration_ms=record.duration_ms,
            status=status,
        )
        return record

    def update_cycle(
        self,
        agent_id: str,
        *,
        scanned: int | None = None,
        failures: int | None = None,
        executed: int | None = None,
        sleep_interval_ms: int | None = None,
        status: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """Update in-flight cycle counters."""
        with self._lock:
            cycle = self._cycles.get(agent_id)
            if cycle is None:
                return
            if scanned is not None:
                cycle.scanned = scanned
            if failures is not None:
                cycle.failures = failures
            if executed is not None:
                cycle.executed = executed
            if sleep_interval_ms is not None:
                cycle.sleep_interval_ms = sleep_interval_ms
            if status is not None:
                cycle.status = status
            if error_message is not None:
                cycle.error_message = error_message

    # ── query helpers ──────────────────────────────────────────

    def get_agent_summary(self, since_minutes: int = 60) -> list[dict]:
        try:
            return self._db.get_agent_summary(since_minutes)
        except Exception:
            logger.exception("agent_summary_query_failed")
            return []

    def get_failure_rate(self, since_minutes: int = 60) -> float:
        try:
            return self._db.get_failure_rate(since_minutes)
        except Exception:
            logger.exception("failure_rate_query_failed")
            return 0.0

    def get_sleep_trend(self, agent_id: str | None = None, limit: int = 50) -> list[dict]:
        try:
            return self._db.get_sleep_trend(agent_id, limit)
        except Exception:
            logger.exception("sleep_trend_query_failed")
            return []

    # ── Prometheus metrics export ──────────────────────────────

    def prometheus_text(self) -> str:
        """Render all heartbeat metrics in Prometheus text format."""
        lines: list[str] = []

        with self._lock:
            active_cycles = dict(self._cycles)

        # Cumulative counters
        lines.append(
            "# HELP paperclip_heartbeat_scanned_total Total tasks scanned across all heartbeats\n"
            "# TYPE paperclip_heartbeat_scanned_total counter\n"
            f"paperclip_heartbeat_scanned_total {self._total_scanned}\n"
        )
        lines.append(
            "# HELP paperclip_heartbeat_failures_total Total task failures detected\n"
            "# TYPE paperclip_heartbeat_failures_total counter\n"
            f"paperclip_heartbeat_failures_total {self._total_failures}\n"
        )
        lines.append(
            "# HELP paperclip_heartbeat_executed_total Total tasks executed\n"
            "# TYPE paperclip_heartbeat_executed_total counter\n"
            f"paperclip_heartbeat_executed_total {self._total_executed}\n"
        )
        lines.append(
            "# HELP paperclip_heartbeat_cycles_total Total heartbeat cycles completed\n"
            "# TYPE paperclip_heartbeat_cycles_total counter\n"
            f"paperclip_heartbeat_cycles_total {self._total_cycles}\n"
        )

        # Flush stats
        lines.append(
            "# HELP paperclip_heartbeat_db_flush_errors_total DB flush error count\n"
            "# TYPE paperclip_heartbeat_db_flush_errors_total counter\n"
            f"paperclip_heartbeat_db_flush_errors_total {self._flush_errors}\n"
        )

        # DB health
        db_healthy = 1 if self._db.health() else 0
        lines.append(
            "# HELP paperclip_metrics_db_healthy Database connection health (1=ok, 0=down)\n"
            "# TYPE paperclip_metrics_db_healthy gauge\n"
            f"paperclip_metrics_db_healthy {db_healthy}\n"
        )

        # Active heartbeats per agent
        lines.append(
            "# HELP paperclip_heartbeat_active_cycles Active heartbeat cycles in flight\n"
            "# TYPE paperclip_heartbeat_active_cycles gauge\n"
        )
        for agent_id, cycle in active_cycles.items():
            safe_agent = agent_id.replace('"', '\\"')
            lines.append(
                f'paperclip_heartbeat_active_cycles{{agent_id="{safe_agent}"}} 1\n'
            )

        # Current cycle durations (gauge, ms)
        lines.append(
            "# HELP paperclip_heartbeat_cycle_duration_ms Current cycle duration in ms\n"
            "# TYPE paperclip_heartbeat_cycle_duration_ms gauge\n"
        )
        for agent_id, cycle in active_cycles.items():
            safe_agent = agent_id.replace('"', '\\"')
            lines.append(
                f'paperclip_heartbeat_cycle_duration_ms{{agent_id="{safe_agent}"}} {cycle.duration_ms}\n'
            )

        # Agent status from recent DB records
        lines.append(
            "# HELP paperclip_agent_heartbeat_status Agent status (1=healthy, 0=unhealthy, 2=degraded)\n"
            "# TYPE paperclip_agent_heartbeat_status gauge\n"
        )
        try:
            summary = self._db.get_agent_summary(since_minutes=15)
            status_map = {"healthy": 1, "unhealthy": 0, "degraded": 2}
            for row in summary:
                agent = row["agent_id"].replace('"', '\\"')
                st = row.get("last_error_status") or "healthy"
                val = status_map.get(st, 1)
                lines.append(
                    f'paperclip_agent_heartbeat_status{{agent_id="{agent}"}} {val}\n'
                )
        except Exception:
            pass

        # Sleep interval trend (last known per agent)
        lines.append(
            "# HELP paperclip_heartbeat_sleep_interval_ms Last sleep interval per agent\n"
            "# TYPE paperclip_heartbeat_sleep_interval_ms gauge\n"
        )
        try:
            sleep_data = self._db.get_sleep_trend(limit=20)
            seen: set[str] = set()
            for row in sleep_data:
                agent = row["agent_id"].replace('"', '\\"')
                if agent in seen:
                    continue
                seen.add(agent)
                lines.append(
                    f'paperclip_heartbeat_sleep_interval_ms{{agent_id="{agent}"}} {row["sleep_interval_ms"]}\n'
                )
        except Exception:
            pass

        return "".join(lines)

    # ── cleanup ────────────────────────────────────────────────

    def close(self) -> None:
        with self._lock:
            orphaned = list(self._cycles.keys())
        for agent_id in orphaned:
            self.end_cycle(agent_id, status="orphaned", error_message="collector shutdown")


# Singleton instance
_collector: HeartbeatMetricsCollector | None = None


def get_collector() -> HeartbeatMetricsCollector:
    global _collector
    if _collector is None:
        raise RuntimeError("HeartbeatMetricsCollector not initialized — call init_collector first")
    return _collector


def init_collector(db: MetricsDB, **kwargs) -> HeartbeatMetricsCollector:
    global _collector
    _collector = HeartbeatMetricsCollector(db, **kwargs)
    return _collector
