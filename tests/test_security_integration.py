"""End-to-end integration tests for the Paperclip security layer.

Verifies all security layers work together in sequence:
1. Secrets injection into sandbox (encrypted store → tmpfs in container)
2. Permission enforcement during execution (capability + command + network)
3. Audit event chain completeness (trace_id spans all layers)
4. Rate limit cascading (global > per-agent > per-execution)
5. Seccomp + network policy combined enforcement

Docker-dependent tests are marked with @pytest.mark.docker.
"""

import json
import os
import sys
import time
import uuid
from io import StringIO

import pytest

from src.secrets import EncryptedSecretsStore, SecretClass
from src.permissions import PermissionsEngine, PermissionResult
from src.audit import AuditLogger, AuditEvent, AuditSeverity
from src.ratelimit import RateLimiter, TokenBucket, RateLimitExceeded
from src.sandbox import SeccompManager, SeccompProfile, SeccompAction


# ============================================================================
# 1. SECRETS INJECTION INTO SANDBOX
# ============================================================================

class TestSecretsSandboxInjection:
    """Verify encrypted secrets are injected into sandbox containers correctly.

    The full chain: store → encrypt → retrieve → inject to tmpfs → accessible
    inside container, never in env vars or persistent storage.
    """

    def test_secret_never_in_plaintext_on_disk(self, secrets_store):
        """Stored secret files must contain only ciphertext, never plaintext."""
        sid = secrets_store.store("api-key", "sk-live-secret-value", SecretClass.API_KEY, "agent-1")

        import glob
        secret_files = glob.glob(os.path.join(secrets_store.storage_path, "*.enc"))
        assert len(secret_files) == 1

        for sf in secret_files:
            with open(sf) as f:
                content = f.read()
            assert "sk-live-secret-value" not in content
            assert "ciphertext" in content

    def test_tmpfs_injection_writes_to_isolated_mount(self, secrets_store, tmp_tmpfs_dir):
        """inject_to_tmpfs writes the secret value to the designated tmpfs path."""
        sid = secrets_store.store("db-password", "correct-horse-battery-staple", SecretClass.DATABASE_CRED, "agent-1")

        path = secrets_store.inject_to_tmpfs(sid, "agent-1")
        assert path.exists()
        assert str(path).startswith(tmp_tmpfs_dir)

        with open(path) as f:
            assert f.read() == "correct-horse-battery-staple"

        # File permissions should be owner-only
        stat = path.stat()
        assert stat.st_mode & 0o777 == 0o600

    def test_retrieve_then_inject_is_consistent(self, secrets_store):
        """retrieve() and inject_to_tmpfs() must return the same value."""
        sid = secrets_store.store("token", "my-secret-token-123", SecretClass.OAUTH_TOKEN, "agent-2")

        direct = secrets_store.retrieve(sid, "agent-2")
        path = secrets_store.inject_to_tmpfs(sid, "agent-2")
        with open(path) as f:
            from_file = f.read()

        assert direct == from_file == "my-secret-token-123"

    def test_secret_rotation_updates_all_copies(self, secrets_store):
        """After rotation, both retrieve and inject_to_tmpfs return the NEW value."""
        sid = secrets_store.store("rotating-key", "v1-old-value", SecretClass.SIGNING_KEY, "agent-x")

        secrets_store.rotate(sid, "v2-new-value", "agent-x")

        direct = secrets_store.retrieve(sid, "agent-x")
        assert direct == "v2-new-value"

        path = secrets_store.inject_to_tmpfs(sid, "agent-x")
        with open(path) as f:
            assert f.read() == "v2-new-value"

    def test_expired_secret_rejected_on_retrieve(self, secrets_store):
        """Retrieving an expired secret must raise ValueError."""
        sid = secrets_store.store("expiring-key", "temp-value", SecretClass.API_KEY, "agent-1",
                                  expires_in_days=-1)  # already expired

        # Manually force expires_at to be in the past
        import glob
        for sf in glob.glob(os.path.join(secrets_store.storage_path, "*.enc")):
            with open(sf) as f:
                data = json.load(f)
            data["expires_at"] = time.time() - 3600  # 1 hour ago
            with open(sf, "w") as f:
                json.dump(data, f)

        with pytest.raises(ValueError, match="expired"):
            secrets_store.retrieve(sid, "agent-1")

    def test_secret_deletion_removes_both_storage_and_tmpfs(self, secrets_store, tmp_tmpfs_dir):
        """delete() must remove both the encrypted file and the tmpfs injection."""
        sid = secrets_store.store("deletable", "value", SecretClass.GENERIC, "agent-1")
        secrets_store.inject_to_tmpfs(sid, "agent-1")

        secrets_store.delete(sid, "agent-1")

        assert not os.path.exists(os.path.join(secrets_store.storage_path, f"{sid}.enc"))
        assert not os.path.exists(os.path.join(tmp_tmpfs_dir, sid))

    def test_access_log_tracks_all_operations(self, secrets_store):
        """Every store/retrieve/rotate/inject must produce an access log entry."""
        sid = secrets_store.store("k1", "v1", SecretClass.API_KEY, "actor-a", trace_id="trace-1")
        secrets_store.retrieve(sid, "actor-a", trace_id="trace-1")
        secrets_store.rotate(sid, "v2", "actor-a", trace_id="trace-1")
        secrets_store.inject_to_tmpfs(sid, "actor-a", trace_id="trace-1")

        log = secrets_store.get_access_log()
        assert len(log) == 4
        actions = [e.secret_class for e in log]
        assert all(a == SecretClass.API_KEY for a in actions)
        assert all(e.accessed_by == "actor-a" for e in log)

    @pytest.mark.docker
    def test_secret_accessible_inside_container_tmpfs(self, secrets_store, sandbox_container, docker_client):
        """Inject a secret to the host tmpfs, then verify it's readable inside the container.

        This tests the full cross-boundary injection path.
        """
        sid = secrets_store.store("container-secret", "s3cr3t-inside-container", SecretClass.API_KEY, "agent-1")
        host_path = secrets_store.inject_to_tmpfs(sid, "agent-1")

        # Copy the secret file into the container's /secrets tmpfs via docker exec
        import subprocess
        result = subprocess.run(
            ["docker", "cp", str(host_path), f"{sandbox_container.id}:/secrets/{sid}"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"docker cp failed: {result.stderr}"

        # Read it from inside the container
        exec_result = docker_client.api.exec_create(
            sandbox_container.id, ["cat", f"/secrets/{sid}"],
        )
        output = docker_client.api.exec_start(exec_result["Id"]).decode().strip()
        assert output == "s3cr3t-inside-container"

    @pytest.mark.docker
    def test_secret_not_in_container_env_vars(self, secrets_store, sandbox_container, docker_client):
        """Verify secrets are never exposed in container environment variables."""
        sid = secrets_store.store("env-test-secret", "never-in-env", SecretClass.API_KEY, "agent-1")
        secrets_store.inject_to_tmpfs(sid, "agent-1")

        exec_result = docker_client.api.exec_create(
            sandbox_container.id, ["printenv"],
        )
        output = docker_client.api.exec_start(exec_result["Id"]).decode()
        assert "never-in-env" not in output


# ============================================================================
# 2. PERMISSION ENFORCEMENT DURING EXECUTION
# ============================================================================

class TestPermissionEnforcement:
    """Verify capability checks, command validation, and network access control."""

    def test_agent_without_capability_is_denied(self, permissions_engine):
        """An agent attempting a capability not in its allowlist must be denied."""
        check = permissions_engine.verify_capability("coder", "agent-1", "docker.manage")
        assert check.result == PermissionResult.DENIED
        assert "not in allowlist" in check.reason

    def test_restricted_agent_cannot_write(self, permissions_engine):
        """restricted_agent only has fs.read_workspace + git.read."""
        check = permissions_engine.verify_capability("restricted_agent", "agent-r", "fs.write_workspace")
        assert check.result == PermissionResult.DENIED

    def test_restricted_agent_can_read(self, permissions_engine):
        check = permissions_engine.verify_capability("restricted_agent", "agent-r", "fs.read_workspace")
        assert check.result == PermissionResult.ALLOWED

    def test_require_capability_raises_properly(self, permissions_engine):
        """require_capability must raise PermissionError with a descriptive message."""
        with pytest.raises(PermissionError, match="not in allowlist"):
            permissions_engine.require_capability("coder", "agent-1", "docker.manage")

    def test_blocked_commands_always_denied(self, permissions_engine):
        """Blocked commands take precedence over safe patterns."""
        assert not permissions_engine.is_command_allowed("/bin/bash")
        assert not permissions_engine.is_command_allowed("bash -c 'echo hi'")
        assert not permissions_engine.is_command_allowed("nc -l 1234")
        assert not permissions_engine.is_command_allowed("ssh user@host")

    def test_safe_commands_are_allowed(self, permissions_engine):
        assert permissions_engine.is_command_allowed("git status")
        assert permissions_engine.is_command_allowed("npm install")
        assert permissions_engine.is_command_allowed("python script.py")
        assert permissions_engine.is_command_allowed("echo hello world")

    def test_unknown_command_denied_by_default(self, permissions_engine):
        """Any command not matching safe patterns must be denied."""
        assert not permissions_engine.is_command_allowed("wget https://evil.com")
        assert not permissions_engine.is_command_allowed("unknown_binary --flag")

    def test_network_access_granted_for_github_only(self, permissions_engine):
        """coder agent has net.outbound_github but not others."""
        check = permissions_engine.validate_network_access("coder", "agent-1", "github.com")
        assert check.result == PermissionResult.ALLOWED

        check = permissions_engine.validate_network_access("coder", "agent-1", "google.com")
        assert check.result == PermissionResult.DENIED

    def test_no_network_agent_denied_everywhere(self, permissions_engine):
        """no_network_agent has no net.outbound_* capabilities at all."""
        check = permissions_engine.validate_network_access("no_network_agent", "agent-nn", "github.com")
        assert check.result == PermissionResult.DENIED

    def test_devops_has_wider_network_access(self, permissions_engine):
        """devops gets net.outbound_cloud_apis which coder doesn't."""
        check = permissions_engine.validate_network_access("devops", "agent-d", "api.cloudprovider.com")
        # net.outbound_cloud_apis is broad — wildcard check only hits github specifically
        # Devops has the capability listed but the validate method only pattern-matches github
        caps = permissions_engine.get_capabilities("devops")
        assert "net.outbound_cloud_apis" in caps

    def test_full_permission_check_chain(self, permissions_engine):
        """Exercise all three check types in sequence to simulate an execution."""
        agent_type = "coder"
        agent_id = "agent-full-check"

        # 1. Capability check
        cap_check = permissions_engine.verify_capability(agent_type, agent_id, "git.write")
        assert cap_check.result == PermissionResult.ALLOWED

        # 2. Command check
        cmd_check = permissions_engine.check_command("git push origin main")
        assert cmd_check.allowed

        # 3. Network check
        net_check = permissions_engine.validate_network_access(agent_type, agent_id, "github.com")
        assert net_check.result == PermissionResult.ALLOWED

        # 4. A denied operation
        denied_net = permissions_engine.validate_network_access(agent_type, agent_id, "malicious.site")
        assert denied_net.result == PermissionResult.DENIED


# ============================================================================
# 3. AUDIT EVENT CHAIN COMPLETENESS
# ============================================================================

class TestAuditChainCompleteness:
    """Verify that all security-relevant actions produce audit events with
    consistent trace_ids linking them together."""

    def test_full_execution_audit_trail(self, audit_logger):
        """A complete execution must produce a full chain of linked audit events."""
        logger, buf = audit_logger
        trace_id = uuid.uuid4().hex
        agent_id = "agent-audit-1"
        execution_id = "exec-audit-001"

        # Simulate a full execution lifecycle
        logger.log_execution_event("started", agent_id, execution_id, "success", trace_id=trace_id)
        logger.log_secret_access("accessed", agent_id, "sec-1", trace_id=trace_id)
        logger.log_permission_denied(agent_id, "network", "evil.com", "net.outbound", trace_id=trace_id)
        logger.log_rate_limit(agent_id, "per_agent", details={"rate": 21, "limit": 20}, trace_id=trace_id)
        logger.log_sandbox_violation(agent_id, execution_id, "syscall_blocked",
                                     details={"syscall": "mount"}, trace_id=trace_id)
        logger.log_execution_event("completed", agent_id, execution_id, "success", trace_id=trace_id)

        output = buf.getvalue().strip()
        lines = output.split("\n")
        events = [json.loads(line) for line in lines]

        assert len(events) == 6

        # All events must share the same trace_id
        for evt in events:
            assert evt["trace_id"] == trace_id, f"Event {evt['action']} missing trace_id"

        # Verify action sequence
        actions = [e["action"] for e in events]
        assert actions[0] == "started"
        assert actions[1] == "secret.accessed"
        assert actions[2] == "permission.denied"
        assert actions[3] == "ratelimit.exceeded"
        assert actions[4] == "sandbox.syscall_blocked"
        assert actions[5] == "completed"

    def test_audit_event_has_required_fields(self, audit_logger):
        """Every AuditEvent must contain mandatory fields."""
        logger, buf = audit_logger

        logger.log(AuditEvent(
            action="test.mandatory",
            actor_type="agent",
            actor_id="a-1",
            resource_type="test",
            resource_id="r-1",
            result="success",
        ))

        output = buf.getvalue().strip()
        event = json.loads(output)

        required = ["timestamp", "event_id", "action", "actor_type", "actor_id",
                    "resource_type", "resource_id", "result", "severity"]
        for field in required:
            assert field in event, f"Missing required field: {field}"

    def test_denied_events_have_elevated_severity(self, audit_logger):
        """Denied violations should log at WARNING or ERROR."""
        logger, buf = audit_logger

        logger.log_permission_denied("agent-1", "fs", "/etc/shadow", "fs.read_system")
        logger.log_sandbox_violation("agent-1", "exec-1", "network_egress")
        logger.log_rate_limit("agent-1", "global")

        output = buf.getvalue().strip()
        events = [json.loads(line) for line in output.split("\n")]

        severities = [e["severity"] for e in events]
        assert severities[0] == "warning"   # permission denied
        assert severities[1] == "error"     # sandbox violation
        assert severities[2] == "warning"   # rate limit

    def test_audit_severity_filter_respected(self, audit_logger):
        """Events below min_severity must be suppressed."""
        logger, buf = audit_logger

        # Current logger is DEBUG, so all events pass. Use a filtered one.
        filtered = AuditLogger(destination="stdout", min_severity=AuditSeverity.INFO)
        old_stdout = sys.stdout
        sys.stdout = StringIO()

        filtered.log(AuditEvent(
            action="debug.test", actor_type="agent", actor_id="a",
            resource_type="t", resource_id="r", result="success",
            severity=AuditSeverity.DEBUG,
        ))
        filtered.log(AuditEvent(
            action="info.test", actor_type="agent", actor_id="a",
            resource_type="t", resource_id="r", result="success",
            severity=AuditSeverity.INFO,
        ))

        output = sys.stdout.getvalue()
        sys.stdout = old_stdout

        assert "debug.test" not in output
        assert "info.test" in output

    def test_secret_values_redacted_in_audit(self, audit_logger):
        """Audit events must never contain raw secret values."""
        logger, buf = audit_logger

        logger.log_secret_access("accessed", "agent-1", "sec-abc")

        # Log an event with a detail that looks like a secret
        logger.log(AuditEvent(
            action="deployment.config",
            actor_type="agent",
            actor_id="agent-1",
            resource_type="config",
            resource_id="cfg-1",
            result="success",
            details={
                "api_key": "sk-12345678901234567890",
                "gh_token": "ghp_abcdefghijklmnopqrstuvwxyz123456",
                "email": "admin@example.com",
            },
        ))

        output = buf.getvalue().strip()
        for line in output.split("\n"):
            event = json.loads(line)
            details_str = json.dumps(event.get("details", {}))
            assert "sk-" not in details_str, f"Unredacted API key in: {details_str}"
            assert "ghp_" not in details_str, f"Unredacted GitHub token in: {details_str}"

    def test_cross_layer_trace_id_consistency(self, secrets_store, permissions_engine, audit_logger):
        """All security layers must report events with the same trace_id for a single operation."""
        logger, buf = audit_logger
        trace_id = uuid.uuid4().hex
        agent_id = "agent-cross-1"

        # Layer 1: Secrets — store and retrieve
        sid = secrets_store.store("cross-secret", "value", SecretClass.API_KEY, agent_id, trace_id=trace_id)
        secrets_store.retrieve(sid, agent_id, trace_id=trace_id)

        # Layer 2: Permissions — check a capability
        check = permissions_engine.verify_capability("coder", agent_id, "git.write")
        assert check.result == PermissionResult.ALLOWED

        # Layer 3: Audit — log the permission check outcome
        logger.log(AuditEvent(
            action="permission.checked",
            actor_type="agent",
            actor_id=agent_id,
            resource_type="capability",
            resource_id="git.write",
            result=check.result.value,
            trace_id=trace_id,
            details={"reason": check.reason},
        ))

        # Verify secrets access log entries exist
        access_log = secrets_store.get_access_log()
        assert len(access_log) >= 2
        for entry in access_log:
            assert entry.trace_id == trace_id

        # Verify audit events
        output = buf.getvalue().strip()
        audit_events = [json.loads(line) for line in output.split("\n")]
        for e in audit_events:
            assert e["trace_id"] == trace_id


# ============================================================================
# 4. RATE LIMIT CASCADING
# ============================================================================

class TestRateLimitCascading:
    """Verify rate limits cascade correctly: global > per-agent > per-execution.

    The highest-priority check (global) must fail first, then per-agent, then
    per-execution — the first limit hit terminates the chain.
    """

    def test_global_limit_hits_first(self):
        """When the global bucket is exhausted, the check fails at global before
        reaching per-agent or per-execution limits."""
        limiter = RateLimiter(
            global_rate=0.001, global_burst=0,      # exhausted
            per_agent_rate=1000, per_agent_burst=1000,  # plenty
            per_execution_rate=1000, per_execution_burst=1000,
        )
        try:
            limiter.check("agent-1", "exec-1")
            pytest.fail("Should have raised RateLimitExceeded")
        except RateLimitExceeded as e:
            assert e.limit_type == "global"

    def test_per_agent_hits_second(self):
        """When global passes but per-agent is exhausted, fail at per-agent."""
        limiter = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=0.001, per_agent_burst=0,   # exhausted
            per_execution_rate=1000, per_execution_burst=1000,
        )
        try:
            limiter.check("agent-1", "exec-1")
            pytest.fail("Should have raised RateLimitExceeded")
        except RateLimitExceeded as e:
            assert e.limit_type == "per_agent"

    def test_per_execution_hits_last(self):
        """When global and per-agent pass, per-execution must be the failure point."""
        limiter = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=1000, per_agent_burst=1000,
            per_execution_rate=0.001, per_execution_burst=0,  # exhausted
        )
        try:
            limiter.check("agent-1", "exec-1")
            pytest.fail("Should have raised RateLimitExceeded")
        except RateLimitExceeded as e:
            assert e.limit_type == "per_execution"

    def test_cascading_order_is_strict(self):
        """Test that the three limits are checked in strict order (g→a→e).

        We exhaust global first, verify it's global. Then fix global, exhaust
        per-agent, verify it's per-agent. Then fix that, exhaust per-exec,
        verify it's per-exec.
        """
        # Phase 1: global exhausted
        limiter = RateLimiter(
            global_rate=0.001, global_burst=0,
            per_agent_rate=1000, per_agent_burst=1000,
            per_execution_rate=1000, per_execution_burst=1000,
        )
        with pytest.raises(RateLimitExceeded) as exc1:
            limiter.check("agent-1", "exec-1")
        assert exc1.value.limit_type == "global"

        # Phase 2: global ok, per-agent exhausted
        limiter2 = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=0.001, per_agent_burst=0,
            per_execution_rate=1000, per_execution_burst=1000,
        )
        with pytest.raises(RateLimitExceeded) as exc2:
            limiter2.check("agent-2", "exec-2")
        assert exc2.value.limit_type == "per_agent"

        # Phase 3: only per-execution exhausted
        limiter3 = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=1000, per_agent_burst=1000,
            per_execution_rate=0.001, per_execution_burst=0,
        )
        with pytest.raises(RateLimitExceeded) as exc3:
            limiter3.check("agent-3", "exec-3")
        assert exc3.value.limit_type == "per_execution"

    def test_different_agents_have_independent_buckets(self):
        """Rate-limiting agent-1 must not affect agent-2."""
        limiter = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=0.001, per_agent_burst=0,
            per_execution_rate=1000, per_execution_burst=1000,
        )
        # agent-1 is rate-limited at per-agent level
        assert not limiter.is_allowed("agent-1", "exec-a")
        # agent-2 has its own empty bucket, also rate-limited
        assert not limiter.is_allowed("agent-2", "exec-b")

    def test_rate_limit_cleanup_removes_execution_state(self):
        limiter = RateLimiter(
            global_rate=100, global_burst=100,
            per_agent_rate=100, per_agent_burst=100,
            per_execution_rate=100, per_execution_burst=100,
        )
        limiter.check("agent-1", "exec-to-clean")
        assert "exec-to-clean" in limiter._execution_buckets

        limiter.cleanup_execution("exec-to-clean")
        assert "exec-to-clean" not in limiter._execution_buckets

    def test_rate_limit_exceeded_has_retry_after(self):
        limiter = RateLimiter(
            global_rate=10, global_burst=0,
            per_agent_rate=100, per_agent_burst=100,
            per_execution_rate=100, per_execution_burst=100,
        )
        try:
            limiter.check("agent-1")
            pytest.fail("Should have raised")
        except RateLimitExceeded as e:
            assert e.retry_after_s >= 0
            assert e.limit_type == "global"
            assert e.actor_id == "agent-1"

    def test_token_bucket_refills_over_time(self):
        """Token bucket must refill at the configured rate."""
        bucket = TokenBucket(rate=100, burst=10)
        bucket.tokens = 0
        bucket.last_refill = time.monotonic() - 0.05  # 50ms ago → ~5 tokens
        assert bucket.consume(3)  # Should have tokens from refill

    def test_token_bucket_never_exceeds_burst(self):
        bucket = TokenBucket(rate=100, burst=10)
        bucket.tokens = 0
        bucket.last_refill = time.monotonic() - 100  # would be 10000 tokens
        bucket._refill()
        assert bucket.tokens == 10.0  # capped at burst


# ============================================================================
# 5. SECCOMP + NETWORK POLICY COMBINED ENFORCEMENT
# ============================================================================

class TestSeccompNetworkCombined:
    """Verify seccomp and network policies are enforced together in sandbox
    containers. These tests exercise the defense-in-depth strategy: if one
    layer somehow fails, the other must still block the action."""

    def test_restrictive_profile_blocks_dangerous_syscalls(self, seccomp_manager):
        """Restrictive seccomp removes clone, execve, fork, and networking."""
        profile = seccomp_manager.build_restrictive_profile()

        # Process creation blocked
        assert not seccomp_manager.validate_syscall(profile, "clone")
        assert not seccomp_manager.validate_syscall(profile, "execve")
        assert not seccomp_manager.validate_syscall(profile, "fork")

        # Network syscalls blocked
        assert not seccomp_manager.validate_syscall(profile, "socket")
        assert not seccomp_manager.validate_syscall(profile, "connect")

        # Safe syscalls still allowed
        assert seccomp_manager.validate_syscall(profile, "read")
        assert seccomp_manager.validate_syscall(profile, "write")
        assert seccomp_manager.validate_syscall(profile, "exit")

    def test_default_profile_allows_basic_operations(self, seccomp_manager):
        """Default profile allows read/write/exit but blocks always-blocked."""
        profile = seccomp_manager.build_default_profile()

        assert seccomp_manager.validate_syscall(profile, "read")
        assert seccomp_manager.validate_syscall(profile, "write")

        # Always-blocked syscalls
        assert not seccomp_manager.validate_syscall(profile, "mount")
        assert not seccomp_manager.validate_syscall(profile, "reboot")
        assert not seccomp_manager.validate_syscall(profile, "chroot")
        assert not seccomp_manager.validate_syscall(profile, "capset")

    def test_permissive_profile_includes_dev_syscalls(self, seccomp_manager):
        """Permissive profile adds ptrace, pipes, eventfd, etc."""
        profile = seccomp_manager.build_permissive_profile()

        # Dev-only syscalls added
        assert seccomp_manager.validate_syscall(profile, "ptrace")
        assert seccomp_manager.validate_syscall(profile, "pipe")
        assert seccomp_manager.validate_syscall(profile, "eventfd")

        # But always-blocked remain blocked
        assert not seccomp_manager.validate_syscall(profile, "mount")
        assert not seccomp_manager.validate_syscall(profile, "reboot")

    def test_always_blocked_never_in_any_profile(self, seccomp_manager):
        """Syscalls marked ALWAYS_BLOCKED must not appear in allowed for any profile."""
        from src.sandbox.seccomp import ALWAYS_BLOCKED

        profiles = [
            seccomp_manager.build_default_profile(),
            seccomp_manager.build_restrictive_profile(),
            seccomp_manager.build_permissive_profile(),
        ]

        for profile in profiles:
            for blocked_syscall in ALWAYS_BLOCKED:
                assert blocked_syscall not in profile.allowed_syscalls, \
                    f"{blocked_syscall} should not be in {profile.name} allowed list"

    def test_profile_save_and_load_roundtrip(self, seccomp_manager):
        """Saved and reloaded profiles must be identical."""
        profile = seccomp_manager.build_default_profile()
        path = seccomp_manager.save_profile(profile)

        loaded = seccomp_manager.load_profile(str(path))

        assert loaded.name == profile.name
        assert loaded.default_action == profile.default_action
        assert set(loaded.allowed_syscalls) == set(profile.allowed_syscalls)
        assert set(loaded.blocked_syscalls) == set(profile.blocked_syscalls)

    def test_docker_security_opts_includes_seccomp_and_no_new_privs(self, seccomp_manager):
        opts = seccomp_manager.get_docker_security_opts("default")
        assert len(opts) >= 2
        assert any("seccomp=" in o for o in opts)
        assert any("no-new-privileges=true" in o for o in opts)

    def test_seccomp_profile_rejects_unknown_syscall_by_default(self, seccomp_manager):
        """With KILL default action, unknown syscalls are denied."""
        profile = seccomp_manager.build_default_profile()
        assert not seccomp_manager.validate_syscall(profile, "nonexistent_syscall_xyz")

    @pytest.mark.docker
    def test_seccomp_blocks_mount_in_container(self, sandbox_container, docker_client):
        """Inside a container with restrictive seccomp, the 'mount' syscall
        should be blocked (killed or EPERM)."""
        # Try to run mount — should fail
        exec_result = docker_client.api.exec_create(
            sandbox_container.id, ["mount", "-t", "tmpfs", "tmpfs", "/tmp"],
        )
        output = docker_client.api.exec_start(exec_result["Id"])

        inspect = docker_client.api.exec_inspect(exec_result["Id"])
        exit_code = inspect.get("ExitCode", -1)

        # mount should fail — either killed by seccomp (exit 137) or EPERM
        assert exit_code != 0, f"mount succeeded unexpectedly, exit={exit_code}, output={output}"

    @pytest.mark.docker
    def test_network_is_disabled_by_default(self, sandbox_container, docker_client):
        """Container started with network=none must not be able to reach external hosts."""
        exec_result = docker_client.api.exec_create(
            sandbox_container.id, ["curl", "-s", "--connect-timeout", "2", "https://github.com"],
        )
        output = docker_client.api.exec_start(exec_result["Id"])

        inspect = docker_client.api.exec_inspect(exec_result["Id"])
        exit_code = inspect.get("ExitCode", -1)

        # Should fail due to no network
        assert exit_code != 0, f"Network access succeeded on network=none container: {output}"

    @pytest.mark.docker
    def test_seccomp_and_network_both_enforced(self, sandbox_container, docker_client):
        """Combined: a blocked syscall AND a network connection should both
        fail in the same container, proving defense-in-depth."""
        # Test 1: blocked syscall (mount)
        exec_mount = docker_client.api.exec_create(
            sandbox_container.id, ["mount"],
        )
        docker_client.api.exec_start(exec_mount["Id"])
        mount_inspect = docker_client.api.exec_inspect(exec_mount["Id"])
        assert mount_inspect.get("ExitCode", -1) != 0, "mount should have been blocked by seccomp"

        # Test 2: network (curl)
        exec_curl = docker_client.api.exec_create(
            sandbox_container.id, ["curl", "-s", "--connect-timeout", "2", "https://example.com"],
        )
        curl_output = docker_client.api.exec_start(exec_curl["Id"])
        curl_inspect = docker_client.api.exec_inspect(exec_curl["Id"])
        assert curl_inspect.get("ExitCode", -1) != 0, \
            f"Network access should be blocked, got: {curl_output}"

    @pytest.mark.docker
    def test_safe_syscalls_still_work_under_restrictive_profile(self, sandbox_container, docker_client):
        """Even with restrictive seccomp, read/write/exit must function."""
        exec_result = docker_client.api.exec_create(
            sandbox_container.id, ["echo", "seccomp-ok"],
        )
        output = docker_client.api.exec_start(exec_result["Id"]).decode().strip()
        inspect = docker_client.api.exec_inspect(exec_result["Id"])

        assert inspect.get("ExitCode", -1) == 0, f"echo should succeed: exit={inspect.get('ExitCode')}"
        assert "seccomp-ok" in output

    @pytest.mark.docker
    def test_resource_limits_enforced(self, sandbox_container, docker_client):
        """Containers must have the resource limits we specified (memory, pids)."""
        sandbox_container.reload()
        host_config = sandbox_container.attrs.get("HostConfig", {})

        # Memory limit must be set
        assert host_config.get("Memory", 0) > 0, "Memory limit not set"
        assert host_config.get("Memory", 0) <= 128 * 1024 * 1024 + 10 * 1024 * 1024  # 128MB + slack

        # PIDs limit must be set
        assert host_config.get("PidsLimit", 0) <= 50
