"""Integration layer with the task orchestration engine (PRO-8).

Handles communication between the execution worker runtime and the
task orchestration engine. Provides:

- Job result reporting back to the orchestration engine
- Status updates during job execution
- Callback hooks for orchestration-triggered events
- Retry and error reporting protocol

This is the integration seam — the orchestration engine contract is
abstracted here so the worker runtime itself remains engine-agnostic.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

import structlog
import httpx

from .config import get_config

logger = structlog.get_logger(__name__)


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


@dataclass
class JobResult:
    job_id: str
    status: JobStatus
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: str = ""
    artifacts: list[dict[str, str]] = field(default_factory=list)


class OrchestratorClient:
    """Client for reporting job results back to the orchestration engine.

    Uses a callback-based architecture: the orchestration engine registers
    hooks that the worker runtime calls at lifecycle events.

    For HTTP-based orchestration engines, configure the base_url and the
    client will POST status updates to the engine's API.
    """

    def __init__(
        self,
        base_url: str | None = None,
        api_token: str | None = None,
    ) -> None:
        self._base_url = base_url
        self._api_token = api_token
        self._http: httpx.Client | None = None
        self._on_result: Callable[[JobResult], None] | None = None
        self._on_status_change: Callable[[str, JobStatus], None] | None = None

    def connect(self) -> None:
        if self._base_url:
            self._http = httpx.Client(
                base_url=self._base_url,
                headers={"Authorization": f"Bearer {self._api_token}"}
                if self._api_token
                else {},
                timeout=30.0,
            )

    def register_result_handler(self, handler: Callable[[JobResult], None]) -> None:
        self._on_result = handler

    def register_status_handler(
        self, handler: Callable[[str, JobStatus], None]
    ) -> None:
        self._on_status_change = handler

    def report_status(self, job_id: str, status: JobStatus) -> None:
        logger.info("job_status_update", job_id=job_id, status=status.value)

        if self._on_status_change:
            try:
                self._on_status_change(job_id, status)
            except Exception:
                logger.exception("status_callback_error", job_id=job_id)

        if self._http:
            try:
                self._http.post(
                    f"/api/jobs/{job_id}/status",
                    json={"status": status.value},
                )
            except httpx.HTTPError as e:
                logger.error(
                    "orchestrator_status_http_error",
                    job_id=job_id,
                    error=str(e),
                )

    def report_result(self, result: JobResult) -> None:
        logger.info(
            "job_result",
            job_id=result.job_id,
            status=result.status.value,
            exit_code=result.exit_code,
            duration_ms=result.duration_ms,
        )

        if self._on_result:
            try:
                self._on_result(result)
            except Exception:
                logger.exception("result_callback_error", job_id=result.job_id)

        if self._http:
            try:
                self._http.post(
                    f"/api/jobs/{result.job_id}/result",
                    json={
                        "status": result.status.value,
                        "exit_code": result.exit_code,
                        "duration_ms": result.duration_ms,
                        "error": result.error,
                        "artifacts": result.artifacts,
                    },
                )
            except httpx.HTTPError as e:
                logger.error(
                    "orchestrator_result_http_error",
                    job_id=result.job_id,
                    error=str(e),
                )

    def enqueue_job(
        self,
        job_type: str,
        payload: dict[str, Any],
        *,
        profile: str = "medium",
        timeout_s: int = 600,
        network_access: bool = False,
        workspace: str | None = None,
    ) -> str | None:
        """Enqueue a job via the orchestration engine's API.

        Returns job_id if successful, None if the engine is not configured.
        For direct Redis enqueue, use the Redis client directly instead.
        """
        if not self._http:
            return None

        try:
            resp = self._http.post(
                "/api/jobs",
                json={
                    "type": job_type,
                    "payload": payload,
                    "profile": profile,
                    "timeout_s": timeout_s,
                    "network_access": network_access,
                    "workspace": workspace,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            job_id = data.get("job_id", "")
            logger.info("job_enqueued_via_orchestrator", job_id=job_id)
            return job_id
        except httpx.HTTPError as e:
            logger.error("orchestrator_enqueue_error", error=str(e))
            return None

    def close(self) -> None:
        if self._http:
            self._http.close()
            self._http = None
