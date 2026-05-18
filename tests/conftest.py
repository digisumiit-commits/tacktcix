"""Shared fixtures for security layer integration tests.

These tests exercise the full security stack end-to-end using real Docker
sandbox containers. Markers control whether Docker-dependent tests run.

Usage:
    pytest tests/test_security_integration.py -v -m docker  # full suite
    pytest tests/test_security_integration.py -v             # non-Docker only
"""

import base64
import json
import os
import tempfile
import time

import pytest


# ---------------------------------------------------------------------------
# Pytest markers
# ---------------------------------------------------------------------------

def pytest_configure(config):
    config.addinivalue_line("markers", "docker: integration test requiring a Docker daemon and sandbox image")


# ---------------------------------------------------------------------------
# Docker availability probe
# ---------------------------------------------------------------------------

def _docker_available() -> bool:
    """Check whether the Docker daemon is reachable and the sandbox image exists."""
    try:
        import docker
        client = docker.DockerClient.from_env()
        client.ping()
        try:
            client.images.get("execution-sandbox:latest")
        except Exception:
            client.images.get("execution-sandbox:test")
        client.close()
        return True
    except Exception:
        return False


DOCKER_AVAILABLE = _docker_available()


@pytest.fixture(scope="session")
def docker_available() -> bool:
    return DOCKER_AVAILABLE


# ---------------------------------------------------------------------------
# Temp directories
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_secrets_dir():
    d = tempfile.mkdtemp(prefix="itest-secrets-")
    yield d
    import shutil
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def tmp_tmpfs_dir():
    d = tempfile.mkdtemp(prefix="itest-tmpfs-")
    yield d
    import shutil
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def master_key_file(tmp_secrets_dir):
    key_path = os.path.join(tmp_secrets_dir, "master.key")
    key = base64.b64encode(os.urandom(32)).decode()
    with open(key_path, "w") as f:
        f.write(key)
    return key_path


# ---------------------------------------------------------------------------
# Security layer fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def secrets_store(tmp_secrets_dir, tmp_tmpfs_dir, master_key_file):
    """EncryptedSecretsStore backed by temp directories."""
    from src.secrets import EncryptedSecretsStore

    return EncryptedSecretsStore(
        storage_path=os.path.join(tmp_secrets_dir, "secrets"),
        tmpfs_mount=tmp_tmpfs_dir,
        key_source="local",
        key_file=master_key_file,
    )


@pytest.fixture
def permissions_engine():
    """PermissionsEngine with well-known agent capability definitions."""
    from src.permissions import PermissionsEngine

    agent_capabilities = {
        "coder": [
            "fs.read_workspace", "fs.write_workspace",
            "net.outbound_github", "net.outbound_pypi",
            "git.read", "git.write",
        ],
        "devops": [
            "fs.read_workspace", "fs.write_workspace",
            "net.outbound_github", "net.outbound_cloud_apis",
            "docker.manage", "git.read", "git.write",
        ],
        "restricted_agent": [
            "fs.read_workspace",
            "git.read",
        ],
        "no_network_agent": [
            "fs.read_workspace", "git.read", "git.write",
        ],
    }

    safe_patterns = [
        r"^git$", r"^git\s",
        r"^npm$", r"^npm\s",
        r"^python[3]?$", r"^python[3]?\s",
        r"^curl$", r"^curl\s",
        r"^gh$", r"^gh\s",
        r"^echo$", r"^echo\s",
    ]

    blocked_patterns = [
        r"^/bin/sh$", r"^/bin/bash$",
        r"^sh$", r"^bash$",
        r"^nc$", r"^nc\s",
        r"^ssh$", r"^ssh\s",
    ]

    return PermissionsEngine(
        agent_capabilities=agent_capabilities,
        default_capabilities=["fs.read_workspace", "git.read"],
        safe_command_patterns=safe_patterns,
        blocked_command_patterns=blocked_patterns,
    )


@pytest.fixture
def audit_logger():
    """AuditLogger writing to an in-memory StringIO for assertion."""
    import sys
    from io import StringIO

    from src.audit import AuditLogger, AuditSeverity

    buf = StringIO()
    old_stdout = sys.stdout
    sys.stdout = buf

    logger = AuditLogger(destination="stdout", min_severity=AuditSeverity.DEBUG)

    yield logger, buf

    sys.stdout = old_stdout


@pytest.fixture
def rate_limiter():
    """RateLimiter with predictable thresholds for cascading tests."""
    from src.ratelimit import RateLimiter

    return RateLimiter(
        global_rate=100,
        global_burst=100,
        per_agent_rate=20,
        per_agent_burst=20,
        per_execution_rate=5,
        per_execution_burst=5,
    )


@pytest.fixture
def seccomp_manager():
    """SeccompManager backed by a temp directory."""
    from src.sandbox import SeccompManager

    tmp = tempfile.mkdtemp(prefix="itest-seccomp-")
    mgr = SeccompManager(profile_dir=tmp)
    yield mgr
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Docker client (for tests that need real containers)
# ---------------------------------------------------------------------------

@pytest.fixture
def docker_client(docker_available):
    """Docker client, or None if Docker isn't available."""
    if not docker_available:
        pytest.skip("Docker daemon or sandbox image not available")
    import docker
    client = docker.DockerClient.from_env()
    yield client
    client.close()


def _ensure_sandbox_image(client) -> str:
    """Find the sandbox image tag available on this host."""
    for tag in ("execution-sandbox:latest", "execution-sandbox:test"):
        try:
            client.images.get(tag)
            return tag
        except Exception:
            continue
    try:
        import subprocess
        subprocess.run(
            ["docker", "build", "-t", "execution-sandbox:latest", "-f", "Dockerfile.sandbox", "."],
            check=True, timeout=120,
        )
        return "execution-sandbox:latest"
    except Exception:
        pytest.skip("Cannot build sandbox image")


@pytest.fixture
def sandbox_image(docker_client):
    return _ensure_sandbox_image(docker_client)


@pytest.fixture
def sandbox_container(docker_client, sandbox_image):
    """Create a temporary sandbox container for integration testing.

    The container is auto-removed on teardown. It runs a long-lived sleep
    so tests can exec commands inside it.
    """
    import docker as _docker
    from docker.types import Mount

    # Build seccomp profile JSON for the container
    from src.sandbox import SeccompManager
    seccomp_mgr = SeccompManager()
    restrictive = seccomp_mgr.build_restrictive_profile()
    seccomp_json = json.dumps(restrictive.to_dict())

    container = docker_client.containers.run(
        image=sandbox_image,
        command="sleep 300",
        detach=True,
        remove=True,
        network="none",
        read_only=True,
        cap_drop=["ALL"],
        security_opt=[
            f"seccomp={seccomp_json}",
            "no-new-privileges:true",
        ],
        tmpfs={
            "/tmp": "size=64m,mode=1777",
            "/secrets": "size=16m,mode=0700",
        },
        pids_limit=50,
        mem_limit="128m",
        memswap_limit="256m",
        labels={"paperclip.sandbox": "true", "paperclip.test": "security-integration"},
    )

    # Wait for container to be running
    for _ in range(10):
        container.reload()
        if container.status == "running":
            break
        time.sleep(0.5)

    yield container

    try:
        container.kill()
    except Exception:
        pass
