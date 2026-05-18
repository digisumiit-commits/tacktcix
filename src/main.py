"""Main entry point for the execution worker runtime.

Orchestrates the full worker lifecycle:
1. Load configuration
2. Connect to Docker and Redis
3. Start the health check HTTP server
4. Start the container monitor
5. Consume jobs from Redis streams
6. Handle SIGTERM/SIGINT for graceful shutdown
"""

from __future__ import annotations

import os
import signal
import sys
import time

import structlog

from .config import load_config, get_config
from .consumer import Job, JobQueueConsumer
from .db import MetricsDB
from .health_check import HealthServer, set_healthy
from .heartbeat_metrics import HeartbeatMetricsCollector, init_collector, get_collector
from .orchestrator import JobResult, JobStatus, OrchestratorClient
from .container_runtime import SandboxManager
from .network_egress import NetworkEgressManager
from .sandbox.apparmor import AppArmorManager
from .worker_manager import WorkerManager


def setup_logging() -> None:
    config = get_config()
    processors: list = [
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]
    if config.monitoring.json_logs:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


log = structlog.get_logger(__name__)


class ExecutionWorker:
    """Top-level worker runtime. Wires all components together."""

    def __init__(self) -> None:
        self.config = load_config()
        setup_logging()

        apparmor_mgr = None
        if self.config.sandbox.apparmor_enabled:
            apparmor_mgr = AppArmorManager(
                profile_dir=self.config.sandbox.apparmor_profile_dir
            )

        egress_mgr = NetworkEgressManager(self.config.network_egress)

        self.sandbox = SandboxManager(
            self.config.docker, self.config.sandbox,
            apparmor_manager=apparmor_mgr,
            egress_manager=egress_mgr,
        )
        self.consumer = JobQueueConsumer(
            self.config.redis,
            self.config.worker.id,
            self.config.worker.group,
            self.config.worker.max_concurrent_jobs,
        )
        self.worker_mgr = WorkerManager(self.sandbox, self.config.sandbox)
        self.health_server = HealthServer(self.config.health)
        self.metrics_db = MetricsDB()
        self.heartbeat_collector: HeartbeatMetricsCollector | None = None

        orchestrator_url = os.environ.get("ORCHESTRATOR_URL", "")
        orchestrator_token = os.environ.get("ORCHESTRATOR_API_TOKEN", "")
        self.orchestrator = OrchestratorClient(
            base_url=orchestrator_url or None,
            api_token=orchestrator_token or None,
        )

        self._shutdown_requested = False

    def run(self) -> None:
        log.info(
            "execution_worker_starting",
            worker_id=self.config.worker.id,
            max_concurrent=self.config.worker.max_concurrent_jobs,
            stream=self.config.redis.stream,
            group=self.config.worker.group,
        )

        self.sandbox.connect()
        self.consumer.connect()
        self.orchestrator.connect()

        try:
            self.metrics_db.connect()
            self.heartbeat_collector = init_collector(self.metrics_db)
            log.info("heartbeat_metrics_initialized")
        except Exception:
            log.warning("metrics_db_unavailable_continuing_without")

        self.health_server.start()
        self.worker_mgr.start_monitor()
        self.consumer.register_handler(self._handle_job)

        signal.signal(signal.SIGTERM, self._on_shutdown_signal)
        signal.signal(signal.SIGINT, self._on_shutdown_signal)

        set_healthy(True)
        log.info("execution_worker_ready")

        try:
            self.consumer.start()
        except Exception:
            log.exception("worker_fatal_error")
            set_healthy(False, "Worker main loop crashed")
        finally:
            self._shutdown()

    def _handle_job(self, job: Job) -> None:
        """Handle a job from the queue. Called by the consumer thread."""
        self.orchestrator.report_status(job.id, JobStatus.RUNNING)
        start = time.monotonic()

        try:
            cid = self.worker_mgr.dispatch(job)
        except RuntimeError:
            log.warning("worker_at_capacity_rejecting_job", job_id=job.id)
            self.orchestrator.report_status(job.id, JobStatus.QUEUED)
            return

        exit_code = self.worker_mgr.wait_for_job(cid)
        duration_ms = int((time.monotonic() - start) * 1000)

        with self.worker_mgr._lock:
            exec_ = self.worker_mgr._active.pop(cid, None)

        if exec_ is None:
            return

        if exec_.status == "timeout":
            status = JobStatus.TIMEOUT
            error = f"Job timed out after {exec_.timeout_s}s"
        elif exit_code == 0:
            status = JobStatus.COMPLETED
            error = ""
        else:
            status = JobStatus.FAILED
            error = f"Job exited with code {exit_code}"

        result = JobResult(
            job_id=job.id,
            status=status,
            exit_code=exit_code,
            duration_ms=duration_ms,
            error=error,
        )
        self.orchestrator.report_result(result)

    def _on_shutdown_signal(self, signum: int, frame: object) -> None:
        log.info("shutdown_signal_received", signal=signum)
        self._shutdown_requested = True
        self.consumer.stop()

    def _shutdown(self) -> None:
        log.info("execution_worker_shutting_down")
        set_healthy(False, "Shutting down")

        self.worker_mgr.shutdown(drain=True)
        self.consumer.close()
        self.sandbox.close()
        self.orchestrator.close()

        if self.heartbeat_collector:
            self.heartbeat_collector.close()
        self.metrics_db.close()

        self.health_server.stop()

        log.info("execution_worker_stopped")


def main() -> None:
    worker = ExecutionWorker()
    worker.run()


if __name__ == "__main__":
    main()
