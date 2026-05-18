"""Worker lifecycle manager — spawn, monitor, timeout, cleanup.

Owns the lifecycle of sandbox containers: creates them in response to jobs,
monitors their health and exit status, enforces timeouts, and cleans up
resources after completion.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import structlog

from .config import ResourceProfile, SandboxConfig, get_config
from .consumer import Job
from .container_runtime import SandboxManager

logger = structlog.get_logger(__name__)


@dataclass
class ActiveExecution:
    container_id: str
    job_id: str
    job_type: str
    profile: str
    timeout_s: int
    started_at: float
    status: str = "running"  # running, timeout, completed, failed
    exit_code: int | None = None


class WorkerManager:
    """Manages the full lifecycle of job executions.

    Responsibilities:
    - Dispatch jobs to sandbox containers
    - Enforce per-job timeouts
    - Monitor container health during execution
    - Record exit codes and clean up on completion
    - Handle graceful shutdown (drain running jobs)
    - Prevent exceeding max concurrent jobs
    """

    def __init__(
        self,
        sandbox_mgr: SandboxManager,
        sandbox_cfg: SandboxConfig,
    ) -> None:
        self._sandbox = sandbox_mgr
        self._sandbox_cfg = sandbox_cfg
        self._active: dict[str, ActiveExecution] = {}
        self._lock = threading.Lock()
        self._running = False
        self._monitor_thread: threading.Thread | None = None
        self._shutting_down = False

        max_concurrent = get_config().worker.max_concurrent_jobs
        logger.info(
            "worker_manager_initialized",
            max_concurrent=max_concurrent,
            default_timeout=self._sandbox_cfg.default_timeout_s,
        )

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._active)

    @property
    def is_shutting_down(self) -> bool:
        return self._shutting_down

    def dispatch(self, job: Job) -> str:
        """Dispatch a job to a sandbox container. Returns the container ID.

        Raises RuntimeError if at capacity.
        """
        with self._lock:
            if len(self._active) >= get_config().worker.max_concurrent_jobs:
                raise RuntimeError("Worker at capacity")

        cfg = get_config()
        profiles = cfg.sandbox.profiles
        profile = profiles.get(job.profile, profiles[cfg.sandbox.default_profile])

        # Clamp timeout
        timeout = min(job.timeout_s, self._sandbox_cfg.max_timeout_s)
        if timeout <= 0:
            timeout = self._sandbox_cfg.default_timeout_s

        command = self._build_command(job)
        environment = {
            "PAPERCLIP_JOB_ID": job.id,
            "PAPERCLIP_JOB_TYPE": job.job_type,
            "PAPERCLIP_WORKSPACE": job.workspace or "",
        }

        cid = self._sandbox.create_container(
            job_id=job.id,
            command=command,
            profile=profile,
            timeout_s=timeout,
            network_access=job.network_access,
            workspace=job.workspace,
            environment=environment,
            agent_type=job.agent_type,
            agent_capabilities=job.agent_capabilities if job.agent_capabilities else None,
        )

        execution = ActiveExecution(
            container_id=cid,
            job_id=job.id,
            job_type=job.job_type,
            profile=job.profile,
            timeout_s=timeout,
            started_at=time.time(),
        )

        with self._lock:
            self._active[cid] = execution

        return cid

    def _build_command(self, job: Job) -> str:
        """Build the command string to execute inside the sandbox."""
        pl = job.payload
        script = pl.get("script", "")
        entrypoint = pl.get("entrypoint", "")

        if entrypoint:
            parts = [entrypoint]
            if script:
                parts.append(script)
            return " && ".join(parts)

        if script:
            return script

        cmd = pl.get("command", pl.get("cmd", ""))
        args = pl.get("args", [])
        if isinstance(args, list) and args:
            cmd = f"{cmd} {' '.join(str(a) for a in args)}"
        return cmd or "echo 'No command specified'"

    def start_monitor(self) -> None:
        self._running = True
        self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._monitor_thread.start()
        logger.info("worker_monitor_started")

    def _monitor_loop(self) -> None:
        check_interval = get_config().health.check_interval_s
        while self._running:
            self._check_active_containers()
            time.sleep(check_interval)

    def _check_active_containers(self) -> None:
        with self._lock:
            executions = list(self._active.items())

        for cid, exec_ in executions:
            elapsed = time.time() - exec_.started_at

            # Timeout check
            if elapsed > exec_.timeout_s:
                logger.warning(
                    "job_timeout",
                    job_id=exec_.job_id,
                    container_id=cid,
                    timeout_s=exec_.timeout_s,
                    elapsed_s=elapsed,
                )
                self._sandbox.kill_container(cid)
                with self._lock:
                    if cid in self._active:
                        self._active[cid].status = "timeout"

            # Status check
            status = self._sandbox.container_status(cid)
            if status is None:
                # Container removed — already cleaned up
                with self._lock:
                    self._active.pop(cid, None)
                continue

            if status == "exited":
                exit_code = self._sandbox.container_exit_code(cid)
                with self._lock:
                    if cid in self._active:
                        self._active[cid].status = "completed" if exit_code == 0 else "failed"
                        self._active[cid].exit_code = exit_code
                logger.info(
                    "job_completed",
                    job_id=exec_.job_id,
                    container_id=cid,
                    exit_code=exit_code,
                    elapsed_s=elapsed,
                )
                self._sandbox.stop_container(cid)

    def wait_for_job(self, container_id: str, poll_interval: float = 0.5) -> int | None:
        """Block until a job completes. Returns exit code or None if not found."""
        while True:
            with self._lock:
                exec_ = self._active.get(container_id)

            if exec_ is None:
                return None

            if exec_.status in ("completed", "failed", "timeout"):
                return exec_.exit_code

            time.sleep(poll_interval)

    def get_active_jobs(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "container_id": e.container_id,
                    "job_id": e.job_id,
                    "job_type": e.job_type,
                    "profile": e.profile,
                    "status": e.status,
                    "elapsed_s": time.time() - e.started_at,
                    "exit_code": e.exit_code,
                }
                for e in self._active.values()
            ]

    def shutdown(self, drain: bool = True) -> None:
        """Graceful shutdown. Drains running jobs if drain=True."""
        self._shutting_down = True
        logger.info("worker_manager_shutdown_started", drain=drain)

        if drain:
            timeout = get_config().worker.shutdown_timeout
            deadline = time.time() + timeout
            with self._lock:
                pending = list(self._active.values())

            for exec_ in pending:
                remaining = deadline - time.time()
                if remaining <= 0:
                    logger.warning(
                        "shutdown_drain_timeout_killing",
                        job_id=exec_.job_id,
                    )
                    self._sandbox.kill_container(exec_.container_id)
                else:
                    logger.info(
                        "shutdown_waiting_for_job",
                        job_id=exec_.job_id,
                        remaining_s=remaining,
                    )
                    self.wait_for_job(exec_.container_id)
        else:
            with self._lock:
                for cid in list(self._active.keys()):
                    self._sandbox.kill_container(cid)

        self._running = False
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
        logger.info("worker_manager_shutdown_complete")
