"""Tests for configuration loading and validation."""

import os
import pytest
import tempfile
import yaml

from src.config import load_config, ConfigError, AppConfig


class TestConfigLoading:
    def test_load_minimal_config(self):
        worker_yaml = {
            "worker": {"id": "test-worker", "group": "test-group", "max_concurrent_jobs": 2, "shutdown_timeout": 10},
            "redis": {"host": "localhost", "port": 6379, "db": 0, "password": "", "stream": "test:jobs", "claim_timeout_ms": 60000, "block_ms": 1000},
            "docker": {"host": "unix:///var/run/docker.sock", "default_image": "test:latest", "network": "test-net", "pull_policy": "missing"},
            "sandbox": {"default_profile": "small", "default_timeout_s": 300, "max_timeout_s": 1800, "workspace_mount": "/ws", "read_only_rootfs": True, "default_network_access": False, "tmpfs_size_mb": 128, "drop_all_capabilities": True},
            "health": {"port": 9090, "path": "/healthz", "check_interval_s": 5, "max_failures": 2, "auto_restart": False},
            "monitoring": {"log_level": "debug", "json_logs": False, "metrics_interval_s": 15},
        }
        profiles_yaml = {
            "profiles": {
                "small": {"cpu_shares": 512, "cpu_quota": 50000, "cpu_period": 100000, "memory_mb": 256, "memory_swap_mb": 512, "disk_size_gb": 5, "pids_limit": 50, "description": "small profile"},
            }
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            worker_path = os.path.join(tmpdir, "worker.yaml")
            profiles_path = os.path.join(tmpdir, "resource_profiles.yaml")
            with open(worker_path, "w") as f:
                yaml.dump(worker_yaml, f)
            with open(profiles_path, "w") as f:
                yaml.dump(profiles_yaml, f)

            cfg = load_config(config_dir=tmpdir, worker_path=worker_path, profiles_path=profiles_path)

            assert cfg.worker.id == "test-worker"
            assert cfg.worker.max_concurrent_jobs == 2
            assert cfg.redis.stream == "test:jobs"
            assert cfg.sandbox.default_profile == "small"
            assert cfg.sandbox.read_only_rootfs is True
            assert cfg.health.port == 9090
            assert cfg.monitoring.log_level == "debug"
            assert "small" in cfg.sandbox.profiles
            assert cfg.sandbox.profiles["small"].cpu_shares == 512
            assert cfg.sandbox.profiles["small"].memory_mb == 256

    def test_env_var_substitution(self):
        worker_yaml = {
            "worker": {"id": "${WORKER_NAME:-default-name}", "group": "g", "max_concurrent_jobs": 1, "shutdown_timeout": 10},
            "redis": {"host": "localhost", "port": 6379, "db": 0, "password": "", "stream": "s", "claim_timeout_ms": 1000, "block_ms": 1000},
            "docker": {"host": "unix:///", "default_image": "img", "network": "n", "pull_policy": "missing"},
            "sandbox": {"default_profile": "small", "default_timeout_s": 300, "max_timeout_s": 1800, "workspace_mount": "/ws", "read_only_rootfs": True, "default_network_access": False, "tmpfs_size_mb": 128, "drop_all_capabilities": True},
            "health": {"port": 8080, "path": "/h", "check_interval_s": 10, "max_failures": 3, "auto_restart": True},
            "monitoring": {"log_level": "info", "json_logs": True, "metrics_interval_s": 30},
        }
        profiles_yaml = {
            "profiles": {
                "small": {"cpu_shares": 512, "cpu_quota": 50000, "cpu_period": 100000, "memory_mb": 256, "memory_swap_mb": 512, "disk_size_gb": 5, "pids_limit": 50, "description": "s"},
            }
        }

        os.environ["WORKER_NAME"] = "env-worker"
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                worker_path = os.path.join(tmpdir, "worker.yaml")
                profiles_path = os.path.join(tmpdir, "resource_profiles.yaml")
                with open(worker_path, "w") as f:
                    yaml.dump(worker_yaml, f)
                with open(profiles_path, "w") as f:
                    yaml.dump(profiles_yaml, f)

                cfg = load_config(config_dir=tmpdir, worker_path=worker_path, profiles_path=profiles_path)
                assert cfg.worker.id == "env-worker"
        finally:
            del os.environ["WORKER_NAME"]

    def test_default_env_fallback(self):
        worker_yaml = {
            "worker": {"id": "${UNDEFINED_VAR:-fallback-name}", "group": "g", "max_concurrent_jobs": 1, "shutdown_timeout": 10},
            "redis": {"host": "localhost", "port": 6379, "db": 0, "password": "", "stream": "s", "claim_timeout_ms": 1000, "block_ms": 1000},
            "docker": {"host": "unix:///", "default_image": "img", "network": "n", "pull_policy": "missing"},
            "sandbox": {"default_profile": "small", "default_timeout_s": 300, "max_timeout_s": 1800, "workspace_mount": "/ws", "read_only_rootfs": True, "default_network_access": False, "tmpfs_size_mb": 128, "drop_all_capabilities": True},
            "health": {"port": 8080, "path": "/h", "check_interval_s": 10, "max_failures": 3, "auto_restart": True},
            "monitoring": {"log_level": "info", "json_logs": True, "metrics_interval_s": 30},
        }
        profiles_yaml = {
            "profiles": {
                "small": {"cpu_shares": 512, "cpu_quota": 50000, "cpu_period": 100000, "memory_mb": 256, "memory_swap_mb": 512, "disk_size_gb": 5, "pids_limit": 50, "description": "s"},
            }
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            worker_path = os.path.join(tmpdir, "worker.yaml")
            profiles_path = os.path.join(tmpdir, "resource_profiles.yaml")
            with open(worker_path, "w") as f:
                yaml.dump(worker_yaml, f)
            with open(profiles_path, "w") as f:
                yaml.dump(profiles_yaml, f)

            cfg = load_config(config_dir=tmpdir, worker_path=worker_path, profiles_path=profiles_path)
            assert cfg.worker.id == "fallback-name"

    def test_missing_profiles_raises(self):
        profiles_yaml = {"profiles": {}}
        worker_yaml = {
            "worker": {"id": "w", "group": "g", "max_concurrent_jobs": 1, "shutdown_timeout": 10},
            "redis": {"host": "localhost", "port": 6379, "db": 0, "password": "", "stream": "s", "claim_timeout_ms": 1000, "block_ms": 1000},
            "docker": {"host": "unix:///", "default_image": "img", "network": "n", "pull_policy": "missing"},
            "sandbox": {"default_profile": "small", "default_timeout_s": 300, "max_timeout_s": 1800, "workspace_mount": "/ws", "read_only_rootfs": True, "default_network_access": False, "tmpfs_size_mb": 128, "drop_all_capabilities": True},
            "health": {"port": 8080, "path": "/h", "check_interval_s": 10, "max_failures": 3, "auto_restart": True},
            "monitoring": {"log_level": "info", "json_logs": True, "metrics_interval_s": 30},
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            worker_path = os.path.join(tmpdir, "worker.yaml")
            profiles_path = os.path.join(tmpdir, "resource_profiles.yaml")
            with open(worker_path, "w") as f:
                yaml.dump(worker_yaml, f)
            with open(profiles_path, "w") as f:
                yaml.dump(profiles_yaml, f)

            with pytest.raises(ConfigError, match="No resource profiles"):
                load_config(config_dir=tmpdir, worker_path=worker_path, profiles_path=profiles_path)
