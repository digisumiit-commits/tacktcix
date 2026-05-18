"""Redis Streams job queue consumer.

Consumes jobs from the execution stream using consumer groups for reliable
at-least-once delivery. Handles claiming stale pending messages from dead
workers and enforces concurrency limits.
"""

from __future__ import annotations

import json
import signal
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

import redis
import structlog

from .config import RedisConfig

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class Job:
    """A parsed job message from the queue."""

    id: str
    stream_key: str
    job_type: str
    payload: dict[str, Any]
    timeout_s: int
    profile: str
    network_access: bool
    workspace: str | None
    agent_type: str | None = None
    agent_capabilities: list[str] = field(default_factory=list)


class JobQueueConsumer:
    """Consumes jobs from a Redis Stream using consumer groups.

    Each worker instance joins the same consumer group. The group ensures
    each job is delivered to exactly one consumer. Pending messages from
    dead consumers are periodically claimed via XAUTOCLAIM.
    """

    def __init__(
        self,
        config: RedisConfig,
        worker_id: str,
        group: str,
        max_concurrent: int = 4,
    ) -> None:
        self._config = config
        self._worker_id = worker_id
        self._group = group
        self._stream = config.stream
        self._max_concurrent = max_concurrent
        self._client: redis.Redis | None = None
        self._running = False
        self._handler: Callable[[Job], None] | None = None

    @property
    def client(self) -> redis.Redis:
        if self._client is None:
            raise RuntimeError("Consumer not connected")
        return self._client

    def connect(self) -> None:
        self._client = redis.Redis(
            host=self._config.host,
            port=self._config.port,
            db=self._config.db,
            password=self._config.password or None,
            decode_responses=True,
            socket_keepalive=True,
            health_check_interval=30,
        )
        self._client.ping()
        self._ensure_group()
        logger.info(
            "redis_consumer_connected",
            stream=self._stream,
            group=self._group,
            worker=self._worker_id,
        )

    def _ensure_group(self) -> None:
        """Create consumer group if it doesn't exist. Idempotent."""
        try:
            self.client.xgroup_create(
                self._stream, self._group, id="0", mkstream=True
            )
        except redis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise

    def register_handler(self, handler: Callable[[Job], None]) -> None:
        self._handler = handler

    def start(self) -> None:
        if self._handler is None:
            raise RuntimeError("No handler registered")
        self._running = True
        logger.info("job_consumer_started", worker=self._worker_id)

        while self._running:
            try:
                self._tick()
            except redis.RedisError as e:
                logger.error("redis_error_in_consumer_loop", error=str(e))
                time.sleep(1)
            except Exception:
                logger.exception("unexpected_error_in_consumer_loop")
                time.sleep(1)

    def _tick(self) -> None:
        self._claim_stale()
        active = self._active_job_count()
        if active >= self._max_concurrent:
            time.sleep(0.5)
            return

        count = min(self._max_concurrent - active, 4)
        streams = self._read_new(count)
        for stream_key, messages in streams:
            for msg_id, fields in messages:
                job = self._parse_message(stream_key, msg_id, fields)
                logger.info(
                    "job_received",
                    job_id=job.id,
                    job_type=job.job_type,
                    profile=job.profile,
                )
                self._handler(job)
                self.client.xack(self._stream, self._group, msg_id)

    def _claim_stale(self) -> None:
        """Claim pending messages that have timed out (from dead consumers)."""
        min_idle = self._config.claim_timeout_ms
        claimed = self.client.xautoclaim(
            self._stream,
            self._group,
            self._worker_id,
            min_idle_time=min_idle,
            count=10,
        )
        _, messages, _ = claimed
        for msg_id, fields in messages:
            logger.warning(
                "claimed_stale_job",
                job_id=msg_id,
                previous_owner=fields.get("_consumer", "unknown"),
            )
            job = self._parse_message(self._stream, msg_id, fields)
            self._handler(job)
            self.client.xack(self._stream, self._group, msg_id)

    def _read_new(self, count: int) -> list[tuple[str, list[tuple[str, dict]]]]:
        return self.client.xreadgroup(
            groupname=self._group,
            consumername=self._worker_id,
            streams={self._stream: ">"},
            count=count,
            block=self._config.block_ms,
        )

    def _active_job_count(self) -> int:
        """Count pending (in-flight) messages for this consumer."""
        try:
            pending = self.client.xpending_range(
                self._stream, self._group, min="-", max="+", count=1000
            )
            return sum(1 for p in pending if p["consumer"] == self._worker_id)
        except redis.RedisError:
            return 0

    def _parse_message(
        self, stream_key: str, msg_id: str, fields: dict[str, str]
    ) -> Job:
        """Parse raw Redis stream fields into a Job."""
        payload_str = fields.get("payload", "{}")
        try:
            payload = json.loads(payload_str)
        except json.JSONDecodeError:
            logger.error("invalid_job_payload", job_id=msg_id)
            payload = {}

        agent_caps_raw = fields.get("agent_capabilities", "")
        agent_capabilities = (
            [c.strip() for c in agent_caps_raw.split(",") if c.strip()]
            if agent_caps_raw
            else []
        )

        return Job(
            id=msg_id,
            stream_key=stream_key,
            job_type=fields.get("type", "unknown"),
            payload=payload,
            timeout_s=int(fields.get("timeout_s", 600)),
            profile=fields.get("profile", "medium"),
            network_access=fields.get("network_access", "false").lower() == "true",
            workspace=fields.get("workspace") or None,
            agent_type=fields.get("agent_type") or None,
            agent_capabilities=agent_capabilities,
        )

    def stop(self) -> None:
        self._running = False
        logger.info("job_consumer_stopping", worker=self._worker_id)

    def close(self) -> None:
        if self._client:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None
