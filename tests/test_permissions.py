"""Tests for scoped permissions engine."""

import pytest
from src.permissions import PermissionsEngine, PermissionResult


AGENT_CAPABILITIES = {
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
}

DEFAULT_CAPS = ["fs.read_workspace", "git.read"]

SAFE_COMMANDS = [
    r"^git$", r"^git\s",
    r"^npm$", r"^npm\s",
    r"^python[3]?$", r"^python[3]?\s",
    r"^pip[3]?$", r"^pip[3]?\s",
    r"^curl$", r"^curl\s",
    r"^gh$", r"^gh\s",
]

BLOCKED_COMMANDS = [
    r"^/bin/sh$", r"^/bin/bash$",
    r"^sh$", r"^bash$",
    r"^nc$", r"^nc\s",
    r"^ssh$", r"^ssh\s",
    r"^chmod\s.*\+s",
]


class TestPermissionsEngine:
    def setup_method(self):
        self.engine = PermissionsEngine(
            agent_capabilities=AGENT_CAPABILITIES,
            default_capabilities=DEFAULT_CAPS,
            safe_command_patterns=SAFE_COMMANDS,
            blocked_command_patterns=BLOCKED_COMMANDS,
        )

    def test_agent_gets_explicit_capabilities(self):
        caps = self.engine.get_capabilities("coder")
        assert "fs.write_workspace" in caps
        assert "net.outbound_github" in caps

    def test_agent_gets_default_capabilities(self):
        caps = self.engine.get_capabilities("coder")
        assert "fs.read_workspace" in caps
        assert "git.read" in caps

    def test_unknown_agent_type_gets_only_defaults(self):
        caps = self.engine.get_capabilities("unknown_type")
        assert "fs.read_workspace" in caps
        assert "git.read" in caps
        assert "docker.manage" not in caps

    def test_verify_capability_allowed(self):
        check = self.engine.verify_capability("coder", "agent-1", "fs.write_workspace")
        assert check.result == PermissionResult.ALLOWED

    def test_verify_capability_denied(self):
        check = self.engine.verify_capability("coder", "agent-1", "docker.manage")
        assert check.result == PermissionResult.DENIED

    def test_require_capability_raises_on_deny(self):
        with pytest.raises(PermissionError):
            self.engine.require_capability("coder", "agent-1", "docker.manage")

    def test_require_capability_passes_on_allow(self):
        check = self.engine.require_capability("coder", "agent-1", "git.read")
        assert check.result == PermissionResult.ALLOWED

    def test_safe_command_allowed(self):
        assert self.engine.is_command_allowed("git status")
        assert self.engine.is_command_allowed("npm install")
        assert self.engine.is_command_allowed("python script.py")
        assert self.engine.is_command_allowed("curl https://example.com")

    def test_blocked_command_denied(self):
        assert not self.engine.is_command_allowed("/bin/bash")
        assert not self.engine.is_command_allowed("bash")
        assert not self.engine.is_command_allowed("nc -l 1234")
        assert not self.engine.is_command_allowed("ssh user@host")

    def test_chmod_setuid_blocked(self):
        assert not self.engine.is_command_allowed("chmod u+s /bin/bash")
        assert self.engine.is_command_allowed("chmod 755 file.sh")  # Normal chmod ok

    def test_unknown_command_denied(self):
        assert not self.engine.is_command_allowed("some_unknown_binary --flag")

    def test_check_command_returns_matched_pattern(self):
        result = self.engine.check_command("git status")
        assert result.allowed
        assert result.matched_pattern is not None

        result = self.engine.check_command("bash -c 'echo hi'")
        assert not result.allowed
        assert result.matched_pattern is not None

    def test_network_access_deny_by_default(self):
        check = self.engine.validate_network_access("coder", "agent-1", "unknown.example.com")
        assert check.result == PermissionResult.DENIED

    def test_network_access_allowed_for_github(self):
        check = self.engine.validate_network_access("coder", "agent-1", "github.com")
        assert check.result == PermissionResult.ALLOWED
