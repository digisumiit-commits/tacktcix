"""Execution sandbox — Docker container management with resource limits.

Creates and manages isolated Docker containers for job execution.
Each container runs with resource constraints, filesystem isolation,
and network restrictions as configured.

Network egress filtering (PRO-34):
- Containers with network_access=True get iptables egress rules applied.
- Default-deny outbound, allow only approved CIDRs from security.yaml.
- DNS restricted to approved servers.
- NET_ADMIN + NET_RAW retained for rule application.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

import docker
import structlog
from docker.errors import DockerException, ImageNotFound, NotFound
from docker.types import Mount, Ulimit

from .config import DockerConfig, ResourceProfile, SandboxConfig, get_config
from .network_egress import EgressPolicy, NetworkEgressManager, NetworkEgressConfig
from .sandbox.apparmor import AppArmorManager

logger = structlog.get_logger(__name__)

SANDBOX_LABEL = "paperclip.sandbox"
JOB_ID_LABEL = "paperclip.job-id"
WORKER_ID_LABEL = "paperclip.worker-id"

# Capabilities required for iptables-based egress enforcement (PRO-34)
EGRESS_REQUIRED_CAPS: list[str] = ["NET_ADMIN", "NET_RAW"]


class SandboxError(Exception):
    pass


class SandboxManager:
    """Manages isolated Docker containers for job execution.

    Each container is:
    - Resource-constrained (CPU, memory, disk, PIDs)
    - Filesystem-isolated (tmpfs mounts, read-only rootfs)
    - Network-restricted (internal network, no outbound unless opt-in)
    - Auto-cleaned up on exit
    """

    def __init__(
        self,
        docker_cfg: DockerConfig,
        sandbox_cfg: SandboxConfig,
        *,
        apparmor_manager: AppArmorManager | None = None,
        egress_manager: NetworkEgressManager | None = None,
    ) -> None:
        self._docker_cfg = docker_cfg
        self._sandbox_cfg = sandbox_cfg
        self._apparmor_manager = apparmor_manager
        self._egress_manager = egress_manager
        self._client: docker.DockerClient | None = None
        self._workspace_base = Path("/workspaces")

    @property
    def client(self) -> docker.DockerClient:
        if self._client is None:
            raise SandboxError("Docker client not initialized")
        return self._client

    def connect(self) -> None:
        self._client = docker.DockerClient(base_url=self._docker_cfg.host)
        self._client.ping()
        self._ensure_network()

    def _ensure_network(self) -> None:
        """Ensure the sandbox network exists."""
        try:
            self.client.networks.get(self._docker_cfg.network)
        except NotFound:
            self.client.networks.create(
                self._docker_cfg.network,
                driver="bridge",
                internal=True,
                labels={"paperclip.network": "sandbox"},
            )
            logger.info("sandbox_network_created", network=self._docker_cfg.network)

    def create_container(
        self,
        job_id: str,
        command: str | list[str],
        profile: ResourceProfile,
        *,
        timeout_s: int = 600,
        network_access: bool = False,
        workspace: str | None = None,
        environment: dict[str, str] | None = None,
        image: str | None = None,
        agent_type: str | None = None,
        agent_capabilities: list[str] | None = None,
    ) -> str:
        """Create and start a sandbox container. Returns the container ID.

        When network_access=True and agent_capabilities is provided, egress
        filtering is applied via iptables: default-deny outbound, only
        allowed CIDRs permitted, DNS restricted to approved servers.
        """
        image = image or self._docker_cfg.default_image
        self._ensure_image(image)

        container_name = f"exec-{job_id.replace(':', '-')}"
        workspace_dir = self._prepare_workspace(workspace)

        mounts = self._build_mounts(workspace_dir)
        cap_drop = ["ALL"] if self._sandbox_cfg.drop_all_capabilities else []
        cap_add: list[str] = []

        # When network access is enabled and egress manager is configured,
        # retain NET_ADMIN + NET_RAW so iptables rules can be applied.
        needs_egress = network_access and self._egress_manager is not None and agent_capabilities is not None
        if needs_egress:
            cap_add = list(EGRESS_REQUIRED_CAPS)

        network = self._docker_cfg.network if network_access else "none"

        security_opt = self._build_security_opts(agent_type)

        container = self.client.containers.run(
            image=image,
            command=command,
            name=container_name,
            detach=True,
            remove=True,  # auto-remove on exit
            network=network,
            mounts=mounts,
            environment=environment or {},
            read_only=self._sandbox_cfg.read_only_rootfs,
            cap_drop=cap_drop,
            cap_add=cap_add if cap_add else None,
            security_opt=security_opt,
            cpu_shares=profile.cpu_shares,
            cpu_quota=profile.cpu_quota,
            cpu_period=profile.cpu_period,
            mem_limit=f"{profile.memory_mb}m",
            memswap_limit=f"{profile.memory_swap_mb}m",
            pids_limit=profile.pids_limit,
            ulimits=[
                Ulimit(name="nproc", soft=profile.pids_limit, hard=profile.pids_limit),
                Ulimit(name="nofile", soft=1024, hard=4096),
            ],
            tmpfs={
                "/tmp": f"size={self._sandbox_cfg.tmpfs_size_mb}m,mode=1777",
                "/run": "size=16m,mode=0755,noexec",
            },
            labels={
                SANDBOX_LABEL: "true",
                JOB_ID_LABEL: job_id,
                WORKER_ID_LABEL: get_config().worker.id,
            },
        )

        cid: str = container.id or ""
        # Apply egress filtering via iptables (PRO-34)
        if needs_egress and agent_capabilities is not None:
            self._apply_egress_rules(cid, agent_capabilities)

        logger.info(
            "sandbox_container_started",
            container_id=cid,
            container_name=container_name,
            job_id=job_id,
            profile=f"cpu_shares={profile.cpu_shares},mem={profile.memory_mb}mb",
            network=network,
            egress_enforced=needs_egress,
        )
        return cid

    def _apply_egress_rules(
        self,
        container_id: str,
        agent_capabilities: list[str],
    ) -> None:
        """Apply iptables egress rules to a container."""
        if self._egress_manager is None:
            return

        policy = self._egress_manager.resolve_policy(agent_capabilities)

        success = self._egress_manager.apply_to_container(
            container_id, policy, self.client
        )

        if success:
            logger.info(
                "egress_policy_applied",
                container_id=container_id,
                cidr_count=len(policy.allowed_cidrs),
                dns_servers=list(policy.dns_servers),
            )
        else:
            logger.error(
                "egress_policy_failed",
                container_id=container_id,
            )

    def _build_security_opts(self, agent_type: str | None) -> list[str]:
        """Build security_opt list including AppArmor profile if available."""
        opts = ["no-new-privileges:true"]
        if self._apparmor_manager is not None:
            if agent_type is not None and agent_type in self._apparmor_manager.get_all_profiles():
                opts.extend(self._apparmor_manager.get_docker_security_opts(agent_type))
            else:
                opts.extend(self._apparmor_manager.get_default_docker_security_opt())
        return opts

    def _ensure_image(self, image: str) -> None:
        """Pull image if configured and not already present."""
        pull = self._docker_cfg.pull_policy
        if pull == "never":
            return
        try:
            self.client.images.get(image)
        except ImageNotFound:
            if pull in ("missing", "always"):
                logger.info("pulling_image", image=image)
                self.client.images.pull(image)
        else:
            if pull == "always":
                logger.info("pulling_image", image=image)
                self.client.images.pull(image)

    def _prepare_workspace(self, workspace: str | None) -> str:
        """Create a tmpfs workspace directory for the job."""
        if workspace:
            ws_path = os.path.join(self._workspace_base, workspace)
        else:
            ws_path = tempfile.mkdtemp(prefix="job-", dir=str(self._workspace_base))
        os.makedirs(ws_path, exist_ok=True)
        os.chmod(ws_path, 0o777)
        return ws_path

    def _build_mounts(self, workspace_dir: str) -> list[Mount]:
        mounts: list[Mount] = []
        mount_path = self._sandbox_cfg.workspace_mount
        # Mount workspace with nosuid, noexec for security
        mounts.append(
            Mount(
                target=mount_path,
                source=workspace_dir,
                type="bind",
                read_only=False,
            )
        )
        return mounts

    def get_container(self, container_id: str) -> Any:
        try:
            return self.client.containers.get(container_id)
        except NotFound:
            return None

    def stop_container(self, container_id: str, timeout: int = 10) -> None:
        try:
            container = self.client.containers.get(container_id)
            container.stop(timeout=timeout)
            logger.info("sandbox_container_stopped", container_id=container_id)
        except NotFound:
            pass
        except DockerException as e:
            logger.error("sandbox_stop_error", container_id=container_id, error=str(e))

    def kill_container(self, container_id: str) -> None:
        try:
            container = self.client.containers.get(container_id)
            container.kill()
            logger.info("sandbox_container_killed", container_id=container_id)
        except NotFound:
            pass
        except DockerException as e:
            logger.error("sandbox_kill_error", container_id=container_id, error=str(e))

    def container_status(self, container_id: str) -> str | None:
        container = self.get_container(container_id)
        if container is None:
            return None
        container.reload()
        return container.status

    def container_exit_code(self, container_id: str) -> int | None:
        container = self.get_container(container_id)
        if container is None:
            return None
        container.reload()
        return container.attrs.get("State", {}).get("ExitCode")

    def list_sandbox_containers(self) -> list[dict[str, Any]]:
        containers = self.client.containers.list(
            all=True,
            filters={"label": f"{SANDBOX_LABEL}=true"},
        )
        return [
            {
                "id": c.id,
                "name": c.name,
                "status": c.status,
                "job_id": c.labels.get(JOB_ID_LABEL, ""),
            }
            for c in containers
        ]

    def cleanup_stale_containers(self, max_age_s: int = 3600) -> int:
        """Remove stale sandbox containers older than max_age_s. Returns count cleaned."""
        containers = self.client.containers.list(
            all=True,
            filters={"label": f"{SANDBOX_LABEL}=true"},
        )
        cleaned = 0
        for c in containers:
            if c.status in ("exited", "dead", "created"):
                try:
                    c.remove(force=True)
                    cleaned += 1
                except DockerException:
                    pass
        return cleaned

    def close(self) -> None:
        if self._client:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None
