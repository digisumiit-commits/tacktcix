"""Tests for worker lifecycle management."""

import time
from unittest.mock import MagicMock, patch

import pytest

from src.worker_manager import WorkerManager, ActiveExecution
from src.consumer import Job
from src.config import SandboxConfig, AppConfig, WorkerConfig, RedisConfig, DockerConfig, HealthConfig, MonitoringConfig, ResourceProfile


@pytest.fixture
def sandbox_cfg():
    profiles = {
        "tiny": ResourceProfile(
            cpu_shares=256, cpu_quota=25000, cpu_period=100000,
            memory_mb=128, memory_swap_mb=256, disk_size_gb=1,
            pids_limit=50, description="tiny",
        ),
        "medium": ResourceProfile(
            cpu_shares=1024, cpu_quota=100000, cpu_period=100000,
            memory_mb=2048, memory_swap_mb=4096, disk_size_gb=10,
            pids_limit=200, description="medium",
        ),
    }
    return SandboxConfig(
        default_profile="medium",
        default_timeout_s=600,
        max_timeout_s=3600,
        workspace_mount="/workspace",
        read_only_rootfs=True,
        default_network_access=False,
        tmpfs_size_mb=256,
        drop_all_capabilities=True,
        profiles=profiles,
    )


@pytest.fixture
def app_cfg(sandbox_cfg):
    return AppConfig(
        worker=WorkerConfig(id="test-worker", group="test", max_concurrent_jobs=2, shutdown_timeout=5),
        redis=RedisConfig(host="localhost", port=6379, db=0, password="", stream="test", claim_timeout_ms=60000, block_ms=1000),
        docker=DockerConfig(host="unix:///", default_image="img", network="net", pull_policy="never"),
        sandbox=sandbox_cfg,
        health=HealthConfig(port=8080, path="/health", check_interval_s=10, max_failures=3, auto_restart=True),
        monitoring=MonitoringConfig(log_level="info", json_logs=True, metrics_interval_s=30),
    )


@pytest.fixture
def mock_sandbox():
    sandbox = MagicMock()
    sandbox.create_container.return_value = "container-abc"
    sandbox.container_status.return_value = "running"
    sandbox.container_exit_code.return_value = None
    return sandbox


@pytest.fixture
def sample_job():
    return Job(
        id="job-1",
        stream_key="test:stream",
        job_type="test",
        payload={"command": "echo hello"},
        timeout_s=300,
        profile="medium",
        network_access=False,
        workspace=None,
    )


class TestWorkerManager:
    def test_dispatch_creates_container(self, mock_sandbox, sandbox_cfg, app_cfg, sample_job):
        with patch("src.worker_manager.get_config", return_value=app_cfg):
            mgr = WorkerManager(mock_sandbox, sandbox_cfg)

            cid = mgr.dispatch(sample_job)

            assert cid == "container-abc"
            mock_sandbox.create_container.assert_called_once()
            assert mgr.active_count == 1

    def test_dispatch_at_capacity_rejects(self, mock_sandbox, sandbox_cfg, app_cfg, sample_job):
        # Set max_concurrent to 0 to simulate full capacity
        full_cfg = AppConfig(
            worker=WorkerConfig(id="test", group="g", max_concurrent_jobs=0, shutdown_timeout=5),
            redis=app_cfg.redis,
            docker=app_cfg.docker,
            sandbox=app_cfg.sandbox,
            health=app_cfg.health,
            monitoring=app_cfg.monitoring,
        )

        with patch("src.worker_manager.get_config", return_value=full_cfg):
            mgr = WorkerManager(mock_sandbox, sandbox_cfg)

            with pytest.raises(RuntimeError, match="capacity"):
                mgr.dispatch(sample_job)

    def test_timeout_detection_kills_container(self, mock_sandbox, sandbox_cfg, app_cfg, sample_job):
        with patch("src.worker_manager.get_config", return_value=app_cfg):
            mgr = WorkerManager(mock_sandbox, sandbox_cfg)

            cid = mgr.dispatch(sample_job)

            # Override to force timeout: set timeout_s to 0 so it's immediately exceeded
            with mgr._lock:
                mgr._active[cid].timeout_s = 0
                mgr._active[cid].started_at = time.time() - 10

            mgr._check_active_containers()
            mock_sandbox.kill_container.assert_called_with(cid)

    def test_completed_job_removed_from_active(self, mock_sandbox, sandbox_cfg, app_cfg, sample_job):
        with patch("src.worker_manager.get_config", return_value=app_cfg):
            mgr = WorkerManager(mock_sandbox, sandbox_cfg)
            cid = mgr.dispatch(sample_job)

            mock_sandbox.container_status.return_value = "exited"
            mock_sandbox.container_exit_code.return_value = 0

            mgr._check_active_containers()

            with mgr._lock:
                assert cid in mgr._active
                assert mgr._active[cid].status == "completed"
                assert mgr._active[cid].exit_code == 0

    def test_shutdown_kills_running_jobs(self, mock_sandbox, sandbox_cfg, app_cfg, sample_job):
        with patch("src.worker_manager.get_config", return_value=app_cfg):
            mgr = WorkerManager(mock_sandbox, sandbox_cfg)
            mgr.dispatch(sample_job)

            mgr.shutdown(drain=False)

            mock_sandbox.kill_container.assert_called_once_with("container-abc")
