"""Tests for audit logging system."""

import json
import re
import sys
from io import StringIO

from src.audit import AuditLogger, AuditEvent, AuditSeverity


class TestAuditLogger:
    def setup_method(self):
        self.logger = AuditLogger(destination="stdout", min_severity=AuditSeverity.DEBUG)
        self._stdout = StringIO()
        self._old_stdout = sys.stdout
        sys.stdout = self._stdout

    def teardown_method(self):
        sys.stdout = self._old_stdout

    def _last_event(self) -> dict:
        output = self._stdout.getvalue().strip()
        lines = output.split("\n")
        assert lines, "No log output"
        return json.loads(lines[-1])

    def test_log_basic_event(self):
        event = AuditEvent(
            action="test.action",
            actor_type="agent",
            actor_id="agent-001",
            resource_type="execution",
            resource_id="exec-001",
            result="success",
        )
        event_id = self.logger.log(event)
        assert event_id

        logged = self._last_event()
        assert logged["action"] == "test.action"
        assert logged["actor_id"] == "agent-001"
        assert logged["result"] == "success"
        assert "timestamp" in logged
        assert "event_id" in logged

    def test_log_execution_event(self):
        event_id = self.logger.log_execution_event(
            action="started", actor_id="agent-1", execution_id="exec-123", result="success"
        )
        logged = self._last_event()
        assert logged["action"] == "started"
        assert logged["resource_type"] == "execution"
        assert logged["resource_id"] == "exec-123"

    def test_log_secret_access(self):
        event_id = self.logger.log_secret_access(
            action="accessed", actor_id="agent-1", secret_id="sec-abc"
        )
        logged = self._last_event()
        assert logged["action"] == "secret.accessed"
        assert logged["resource_type"] == "secret"

    def test_log_permission_denied(self):
        event_id = self.logger.log_permission_denied(
            actor_id="agent-1",
            resource_type="network",
            resource_id="github.com",
            permission="net.outbound_github",
        )
        logged = self._last_event()
        assert logged["action"] == "permission.denied"
        assert logged["result"] == "denied"
        assert logged["severity"] == "warning"

    def test_log_sandbox_violation(self):
        event_id = self.logger.log_sandbox_violation(
            actor_id="agent-1",
            execution_id="exec-456",
            violation_type="syscall_blocked",
            details={"syscall": "mount", "profile": "restrictive"},
        )
        logged = self._last_event()
        assert logged["action"] == "sandbox.syscall_blocked"
        assert logged["result"] == "denied"
        assert logged["severity"] == "error"

    def test_log_rate_limit(self):
        event_id = self.logger.log_rate_limit(
            actor_id="agent-1",
            limit_type="per_agent",
            details={"current_rate": 25, "limit": 20},
        )
        logged = self._last_event()
        assert logged["action"] == "ratelimit.exceeded"
        assert logged["resource_id"] == "per_agent"

    def test_min_severity_filter(self):
        filtered = AuditLogger(destination="stdout", min_severity=AuditSeverity.WARNING)
        # Replace stdout
        old = sys.stdout
        sys.stdout = StringIO()

        filtered.log(AuditEvent(
            action="debug.event", actor_type="agent", actor_id="a",
            resource_type="test", resource_id="r", result="success",
            severity=AuditSeverity.DEBUG,
        ))
        filtered.log(AuditEvent(
            action="warning.event", actor_type="agent", actor_id="a",
            resource_type="test", resource_id="r", result="success",
            severity=AuditSeverity.WARNING,
        ))

        output = sys.stdout.getvalue()
        sys.stdout = old

        assert "debug.event" not in output
        assert "warning.event" in output

    def test_secret_redaction_in_logs(self):
        event = AuditEvent(
            action="auth.check",
            actor_type="agent",
            actor_id="agent-1",
            resource_type="auth",
            resource_id="token-1",
            result="success",
            details={
                "token": "sk-12345678901234567890",
                "email": "user@example.com",
                "safe_field": "visible",
            },
        )
        self.logger.log(event)

        logged = self._last_event()
        details_str = json.dumps(logged["details"])
        assert "sk-" not in details_str
        assert "user@example.com" not in details_str
        assert "visible" in details_str

    def test_github_token_redaction(self):
        event = AuditEvent(
            action="git.push",
            actor_type="agent",
            actor_id="agent-1",
            resource_type="repo",
            resource_id="repo-1",
            result="success",
            details={"auth": "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456"},
        )
        self.logger.log(event)

        logged = self._last_event()
        details_str = json.dumps(logged["details"])
        assert "ghp_" not in details_str
