"""Tests for sandbox container management."""

import pytest
from unittest.mock import MagicMock, patch, call

from src.container_runtime import SandboxManager, SandboxError
from src.config import DockerConfig, SandboxConfig, ResourceProfile


@pytest.fixture
def docker_cfg():
    return DockerConfig(
        host="unix:///var/run/docker.sock",
        default_image="sandbox:latest",
        network="test-net",
        pull_policy="never",
    )


@pytest.fixture
def sandbox_cfg():
    return SandboxConfig(
        default_profile="medium",
        default_timeout_s=600,
        max_timeout_s=3600,
        workspace_mount="/workspace",
        read_only_rootfs=True,
        default_network_access=False,
        tmpfs_size_mb=256,
        drop_all_capabilities=True,
        profiles={},
    )


@pytest.fixture
def profile():
    return ResourceProfile(
        cpu_shares=1024,
        cpu_quota=100000,
        cpu_period=100000,
        memory_mb=2048,
        memory_swap_mb=4096,
        disk_size_gb=10,
        pids_limit=200,
        description="test",
    )


class TestSandboxManager:
    def test_create_container_resource_limits(self, docker_cfg, sandbox_cfg, profile):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.side_effect = __import__("docker.errors", fromlist=["NotFound"]).NotFound("not found")

            mock_container = MagicMock()
            mock_container.id = "abc123"
            mock_client.containers.run.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client

            cid = mgr.create_container(
                job_id="test-job-1",
                command="echo hello",
                profile=profile,
                timeout_s=300,
            )

            assert cid == "abc123"
            mock_client.containers.run.assert_called_once()

            # Verify resource limits were passed
            kwargs = mock_client.containers.run.call_args.kwargs
            assert kwargs["cpu_shares"] == 1024
            assert kwargs["cpu_quota"] == 100000
            assert kwargs["mem_limit"] == "2048m"
            assert kwargs["memswap_limit"] == "4096m"
            assert kwargs["pids_limit"] == 200
            assert kwargs["read_only"] is True
            assert "ALL" in kwargs.get("cap_drop", [])

    def test_create_container_network_isolated(self, docker_cfg, sandbox_cfg, profile):
        """Default network = none (no network access)."""
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.return_value = MagicMock()  # network exists

            mock_container = MagicMock()
            mock_container.id = "def456"
            mock_client.containers.run.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client

            mgr.create_container(
                job_id="test-job-2",
                command="curl http://evil.com",
                profile=profile,
                network_access=False,
            )

            kwargs = mock_client.containers.run.call_args.kwargs
            assert kwargs["network"] == "none"

    def test_create_container_with_network_access(self, docker_cfg, sandbox_cfg, profile):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.return_value = MagicMock()

            mock_container = MagicMock()
            mock_container.id = "ghi789"
            mock_client.containers.run.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client

            mgr.create_container(
                job_id="test-job-3",
                command="echo hello",
                profile=profile,
                network_access=True,
            )

            kwargs = mock_client.containers.run.call_args.kwargs
            assert kwargs["network"] == "test-net"

    def test_stop_container_not_found(self, docker_cfg, sandbox_cfg):
        """Stopping a nonexistent container should not raise."""
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.containers.get.side_effect = __import__("docker.errors", fromlist=["NotFound"]).NotFound("gone")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr.stop_container("nonexistent")
            # Should not raise

    def test_container_not_connected_raises(self, docker_cfg, sandbox_cfg):
        mgr = SandboxManager(docker_cfg, sandbox_cfg)
        with pytest.raises(SandboxError, match="not initialized"):
            _ = mgr.client

    # =========================================================================
    # Lifecycle management
    # =========================================================================

    def test_connect_creates_client_and_pings(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.side_effect = NotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr.connect()

            mock_client.ping.assert_called_once()
            assert mgr._client is mock_client

    def test_connect_creates_network_if_missing(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.side_effect = NotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr.connect()

            mock_client.networks.create.assert_called_once_with(
                docker_cfg.network,
                driver="bridge",
                internal=True,
                labels={"paperclip.network": "sandbox"},
            )

    def test_ensure_network_skips_if_exists(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.return_value = MagicMock()  # exists

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr._ensure_network()

            mock_client.networks.create.assert_not_called()

    def test_connect_ping_failure_raises(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.side_effect = DockerException("ping failed")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            with pytest.raises(DockerException, match="ping failed"):
                mgr.connect()

    def test_close_cleans_up_client(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr.close()
            mock_client.close.assert_called_once()
            assert mgr._client is None

    def test_close_no_client_no_error(self, docker_cfg, sandbox_cfg):
        mgr = SandboxManager(docker_cfg, sandbox_cfg)
        mgr.close()  # Should not raise

    def test_close_client_close_exception_handled(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.close.side_effect = Exception("close error")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr.close()  # Should not raise despite close error

    # =========================================================================
    # Security options
    # =========================================================================

    def test_build_security_opts_no_apparmor(self, docker_cfg, sandbox_cfg):
        mgr = SandboxManager(docker_cfg, sandbox_cfg)
        opts = mgr._build_security_opts(agent_type=None)
        assert opts == ["no-new-privileges:true"]

    def test_build_security_opts_with_apparmor_default(self, docker_cfg, sandbox_cfg):
        apparmor_mgr = MagicMock()
        apparmor_mgr.get_all_profiles.return_value = {}
        apparmor_mgr.get_default_docker_security_opt.return_value = ["apparmor=paperclip-execution-default"]

        mgr = SandboxManager(docker_cfg, sandbox_cfg, apparmor_manager=apparmor_mgr)
        opts = mgr._build_security_opts(agent_type="coder")
        apparmor_mgr.get_default_docker_security_opt.assert_called_once()
        assert "apparmor=paperclip-execution-default" in opts

    def test_build_security_opts_with_apparmor_specific_type(self, docker_cfg, sandbox_cfg):
        apparmor_mgr = MagicMock()
        apparmor_mgr.get_all_profiles.return_value = {"coder": MagicMock()}
        apparmor_mgr.get_docker_security_opts.return_value = ["apparmor=paperclip-execution-coder"]

        mgr = SandboxManager(docker_cfg, sandbox_cfg, apparmor_manager=apparmor_mgr)
        opts = mgr._build_security_opts(agent_type="coder")
        apparmor_mgr.get_docker_security_opts.assert_called_once_with("coder")
        assert "apparmor=paperclip-execution-coder" in opts

    def test_build_security_opts_includes_no_new_privs(self, docker_cfg, sandbox_cfg):
        mgr = SandboxManager(docker_cfg, sandbox_cfg)
        opts = mgr._build_security_opts(agent_type=None)
        assert any("no-new-privileges" in o for o in opts)

    # =========================================================================
    # Egress policy error paths
    # =========================================================================

    def test_egress_noop_when_no_egress_manager(self, docker_cfg, sandbox_cfg, profile):
        """When egress_manager is None, no rules are applied despite network_access."""
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.return_value = MagicMock()
            mock_client.containers.run.return_value = MagicMock(id="noeg-123")

            mgr = SandboxManager(docker_cfg, sandbox_cfg, egress_manager=None)
            mgr._client = mock_client

            cid = mgr.create_container(
                job_id="no-egress-job",
                command="echo hi",
                profile=profile,
                network_access=True,
                agent_capabilities=["net.outbound_github"],
            )

            assert cid == "noeg-123"
            # container should run with network access but no NET_ADMIN/NET_RAW
            kwargs = mock_client.containers.run.call_args.kwargs
            assert kwargs.get("cap_add") is None

    def test_egress_failure_logged_no_crash(self, docker_cfg, sandbox_cfg, profile):
        """Egress manager failure should be logged but not crash create_container."""
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.return_value = MagicMock()
            mock_container = MagicMock()
            mock_container.id = "egfail-456"
            mock_client.containers.run.return_value = mock_container

            egress_mgr = MagicMock()
            egress_mgr.resolve_policy.return_value = MagicMock(allowed_cidrs=(), dns_servers=())
            egress_mgr.apply_to_container.return_value = False  # failure

            mgr = SandboxManager(docker_cfg, sandbox_cfg, egress_manager=egress_mgr)
            mgr._client = mock_client

            cid = mgr.create_container(
                job_id="egress-fail-job",
                command="echo hi",
                profile=profile,
                network_access=True,
                agent_capabilities=["net.outbound_github"],
            )

            # Container should still be created, egress failure is non-fatal
            assert cid == "egfail-456"
            egress_mgr.apply_to_container.assert_called_once()

    # =========================================================================
    # Container query methods
    # =========================================================================

    def test_get_container_found(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_container = MagicMock()
            mock_client.containers.get.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            result = mgr.get_container("abc123")
            assert result is mock_container

    def test_get_container_not_found(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.containers.get.side_effect = NotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            result = mgr.get_container("nonexistent")
            assert result is None

    def test_container_status_running(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_container = MagicMock()
            mock_container.status = "running"
            mock_client.containers.get.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            status = mgr.container_status("abc123")
            assert status == "running"

    def test_container_status_nonexistent(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.containers.get.side_effect = NotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            status = mgr.container_status("nonexistent")
            assert status is None

    def test_container_exit_code(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_container = MagicMock()
            mock_container.attrs = {"State": {"ExitCode": 0}}
            mock_client.containers.get.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            code = mgr.container_exit_code("abc123")
            assert code == 0

    def test_container_exit_code_nonzero(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_container = MagicMock()
            mock_container.attrs = {"State": {"ExitCode": 1}}
            mock_client.containers.get.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            code = mgr.container_exit_code("abc123")
            assert code == 1

    def test_container_exit_code_nonexistent(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.containers.get.side_effect = NotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            code = mgr.container_exit_code("nonexistent")
            assert code is None

    # =========================================================================
    # Container listing and cleanup
    # =========================================================================

    def test_list_sandbox_containers(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True

            c1 = MagicMock()
            c1.id = "aaa111"
            c1.name = "exec-job-1"
            c1.status = "running"
            c1.labels = {"paperclip.job-id": "job-1"}
            c2 = MagicMock()
            c2.id = "bbb222"
            c2.name = "exec-job-2"
            c2.status = "exited"
            c2.labels = {"paperclip.job-id": "job-2"}

            mock_client.containers.list.return_value = [c1, c2]

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            result = mgr.list_sandbox_containers()

            assert len(result) == 2
            assert result[0]["id"] == "aaa111"
            assert result[0]["job_id"] == "job-1"
            assert result[1]["status"] == "exited"
            mock_client.containers.list.assert_called_once_with(
                all=True,
                filters={"label": "paperclip.sandbox=true"},
            )

    def test_list_sandbox_containers_empty(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.containers.list.return_value = []

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            result = mgr.list_sandbox_containers()
            assert result == []

    def test_cleanup_stale_containers_removes_exited(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True

            exited = MagicMock()
            exited.status = "exited"
            dead = MagicMock()
            dead.status = "dead"
            created = MagicMock()
            created.status = "created"
            running = MagicMock()
            running.status = "running"

            mock_client.containers.list.return_value = [exited, dead, created, running]

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            cleaned = mgr.cleanup_stale_containers()

            assert cleaned == 3
            exited.remove.assert_called_once_with(force=True)
            dead.remove.assert_called_once_with(force=True)
            created.remove.assert_called_once_with(force=True)
            running.remove.assert_not_called()

    def test_cleanup_no_stale_containers(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True

            running = MagicMock()
            running.status = "running"
            mock_client.containers.list.return_value = [running]

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            cleaned = mgr.cleanup_stale_containers()
            assert cleaned == 0
            running.remove.assert_not_called()

    def test_cleanup_handles_remove_exception(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True

            bad = MagicMock()
            bad.status = "exited"
            bad.remove.side_effect = DockerException("remove failed")

            good = MagicMock()
            good.status = "exited"
            good.remove.return_value = None

            mock_client.containers.list.return_value = [bad, good]

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            cleaned = mgr.cleanup_stale_containers()

            # Bad container remove exception is caught, good one succeeds
            assert cleaned == 1
            bad.remove.assert_called_once_with(force=True)
            good.remove.assert_called_once_with(force=True)

    # =========================================================================
    # Kill container
    # =========================================================================

    def test_kill_container(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_container = MagicMock()
            mock_client.containers.get.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr.kill_container("abc123")
            mock_container.kill.assert_called_once()

    def test_kill_container_not_found(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.containers.get.side_effect = NotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr.kill_container("nonexistent")  # Should not raise

    def test_kill_container_docker_error(self, docker_cfg, sandbox_cfg):
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_container = MagicMock()
            mock_container.kill.side_effect = DockerException("kill failed")
            mock_client.containers.get.return_value = mock_container

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr.kill_container("abc123")  # Should not raise, logs error

    # =========================================================================
    # Image handling
    # =========================================================================

    def test_ensure_image_exists_pull_missing(self, docker_cfg, sandbox_cfg):
        docker_cfg.pull_policy = "missing"
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.images.get.side_effect = ImageNotFound("not found")

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr._ensure_image("test-image:latest")
            mock_client.images.pull.assert_called_once_with("test-image:latest")

    def test_ensure_image_never_policy_skips(self, docker_cfg, sandbox_cfg):
        docker_cfg.pull_policy = "never"
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr._ensure_image("test-image:latest")
            mock_client.images.pull.assert_not_called()
            mock_client.images.get.assert_not_called()

    def test_ensure_image_always_policy(self, docker_cfg, sandbox_cfg):
        docker_cfg.pull_policy = "always"
        with patch("docker.DockerClient") as mock_client_cls:
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.images.get.return_value = MagicMock()  # exists locally

            mgr = SandboxManager(docker_cfg, sandbox_cfg)
            mgr._client = mock_client
            mgr._ensure_image("test-image:latest")
            # Should pull even though image exists (always policy)
            mock_client.images.pull.assert_called_once_with("test-image:latest")
