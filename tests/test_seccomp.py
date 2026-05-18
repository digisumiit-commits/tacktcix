"""Tests for seccomp profile management."""

import json
import tempfile
from pathlib import Path

from src.sandbox import SeccompProfile, SeccompManager, SeccompAction


class TestSeccompProfile:
    def test_to_dict_format(self):
        profile = SeccompProfile(
            name="test",
            default_action=SeccompAction.KILL,
            allowed_syscalls=["read", "write", "exit"],
            blocked_syscalls=["mount", "reboot"],
        )
        d = profile.to_dict()
        assert d["defaultAction"] == "SCMP_ACT_KILL"
        assert "SCMP_ARCH_X86_64" in d["architectures"]

        allowed_entry = None
        blocked_entry = None
        for entry in d["syscalls"]:
            if entry["action"] == "SCMP_ACT_ALLOW":
                allowed_entry = entry
            elif entry["action"] == "SCMP_ACT_KILL":
                blocked_entry = entry

        assert allowed_entry is not None
        assert "read" in allowed_entry["names"]
        assert blocked_entry is not None
        assert "mount" in blocked_entry["names"]

    def test_to_json(self):
        profile = SeccompProfile(
            name="test",
            allowed_syscalls=["read", "write"],
            blocked_syscalls=["mount"],
        )
        json_str = profile.to_json()
        parsed = json.loads(json_str)
        assert parsed["defaultAction"] == "SCMP_ACT_KILL"

    def test_to_docker_config(self):
        profile = SeccompProfile(
            name="test",
            allowed_syscalls=["read", "write"],
            blocked_syscalls=["mount"],
        )
        config = profile.to_docker_config()
        assert "SecurityOpt" in config
        assert config["SecurityOpt"][0].startswith("seccomp=")


class TestSeccompManager:
    def setup_method(self):
        self.tmp = tempfile.mkdtemp()
        self.manager = SeccompManager(profile_dir=self.tmp)

    def test_build_default_profile(self):
        profile = self.manager.build_default_profile()
        assert profile.name == "default"
        assert profile.default_action == SeccompAction.KILL
        assert "read" in profile.allowed_syscalls
        assert "write" in profile.allowed_syscalls
        assert "mount" in profile.blocked_syscalls
        assert "reboot" in profile.blocked_syscalls

    def test_build_restrictive_profile_removes_clone_exec(self):
        profile = self.manager.build_restrictive_profile()
        assert profile.name == "restrictive"
        assert "clone" not in profile.allowed_syscalls
        assert "execve" not in profile.allowed_syscalls
        assert "fork" not in profile.allowed_syscalls
        # Socket-related should also be removed
        assert "socket" not in profile.allowed_syscalls
        assert "connect" not in profile.allowed_syscalls

    def test_build_permissive_profile_adds_dev_syscalls(self):
        profile = self.manager.build_permissive_profile()
        assert profile.name == "permissive"
        assert "ptrace" in profile.allowed_syscalls
        assert "pipe" in profile.allowed_syscalls

    def test_get_profile_default(self):
        profile = self.manager.get_profile("default")
        assert profile is not None
        assert profile.name == "default"

    def test_get_profile_unknown_returns_none(self):
        profile = self.manager.get_profile("nonexistent")
        assert profile is None

    def test_save_and_load_profile(self):
        profile = self.manager.build_default_profile()
        path = self.manager.save_profile(profile)
        assert path.exists()

        loaded = self.manager.load_profile(str(path))
        assert loaded.name == "default"
        assert "read" in loaded.allowed_syscalls
        assert "mount" in loaded.blocked_syscalls

    def test_validate_syscall_allowed(self):
        profile = self.manager.build_default_profile()
        assert self.manager.validate_syscall(profile, "read") is True
        assert self.manager.validate_syscall(profile, "write") is True

    def test_validate_syscall_blocked(self):
        profile = self.manager.build_default_profile()
        assert self.manager.validate_syscall(profile, "mount") is False
        assert self.manager.validate_syscall(profile, "reboot") is False

    def test_get_docker_security_opts(self):
        opts = self.manager.get_docker_security_opts("default")
        assert len(opts) >= 2
        assert any("seccomp=" in o for o in opts)
        assert any("no-new-privileges=true" in o for o in opts)
