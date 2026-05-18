"""Tests for AppArmor profile management."""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from src.sandbox.apparmor import (
    AppArmorProfile,
    AppArmorManager,
    AppArmorCapability,
    AppArmorNetwork,
    AGENT_CAPABILITIES,
    AGENT_FILESYSTEM_RULES,
    AGENT_NETWORK_RULES,
    COMMON_READONLY_PATHS,
    ALWAYS_DENY_PATHS,
)


class TestAppArmorProfile:
    def test_generate_minimal_profile(self):
        """A minimal profile should produce valid AppArmor syntax."""
        profile = AppArmorProfile(
            name="paperclip-test",
            capabilities=[AppArmorCapability.DAC_OVERRIDE],
            filesystem_rules=["/workspace/** r", "/tmp/** r"],
            network_rules=[AppArmorNetwork.UNIX_STREAM],
        )
        output = profile.generate()

        assert "profile paperclip-test" in output
        assert "flags=(attach_disconnected,mediate_deleted)" in output
        assert "#include <tunables/global>" in output
        assert "capability dac_override," in output
        assert "deny capability," in output
        assert "/workspace/** r," in output
        assert "network unix stream," in output
        assert "deny network," in output
        assert "deny mount," in output
        assert "deny pivot_root," in output

    def test_generate_includes_comment(self):
        profile = AppArmorProfile(
            name="paperclip-test",
            comment="Test agent execution profile",
        )
        output = profile.generate()
        assert "# Test agent execution profile" in output

    def test_write_profile_to_disk(self):
        profile = AppArmorProfile(
            name="paperclip-execution-test",
            capabilities=[AppArmorCapability.DAC_OVERRIDE],
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = profile.write(Path(tmp) / "paperclip-execution-test")
            assert path.exists()
            content = path.read_text()
            assert "profile paperclip-execution-test" in content

    def test_to_docker_security_opt(self):
        profile = AppArmorProfile(name="paperclip-execution-coder")
        opt = profile.to_docker_security_opt()
        assert opt == "apparmor=paperclip-execution-coder"

    def test_always_deny_paths_are_included(self):
        profile = AppArmorProfile(
            name="paperclip-test",
            filesystem_rules=["/workspace/** rw"],
        )
        output = profile.generate()
        for denied in ALWAYS_DENY_PATHS[:3]:
            assert f"deny {denied}" in output

    def test_signal_and_ptrace_restrictions(self):
        profile = AppArmorProfile(name="paperclip-test")
        output = profile.generate()
        assert "signal (receive) peer=unconfined," in output
        assert "signal (send) peer={paperclip-test}," in output
        assert "deny ptrace (readby) peer=unconfined," in output
        assert "deny ptrace (tracedby) peer=unconfined," in output

    def test_capabilities_are_sorted(self):
        profile = AppArmorProfile(
            name="paperclip-test",
            capabilities=[
                AppArmorCapability.SETUID,
                AppArmorCapability.CHOWN,
                AppArmorCapability.DAC_OVERRIDE,
            ],
        )
        output = profile.generate()
        chown_idx = output.index("capability chown,")
        dac_idx = output.index("capability dac_override,")
        setuid_idx = output.index("capability setuid,")
        assert chown_idx < dac_idx < setuid_idx

    def test_network_rules_are_sorted(self):
        profile = AppArmorProfile(
            name="paperclip-test",
            network_rules=[
                AppArmorNetwork.INET_TCP,
                AppArmorNetwork.UNIX_STREAM,
                AppArmorNetwork.INET_UDP,
            ],
        )
        output = profile.generate()
        tcp_idx = output.index("network inet tcp,")
        udp_idx = output.index("network inet udp,")
        unix_idx = output.index("network unix stream,")
        assert tcp_idx < udp_idx < unix_idx


class TestAppArmorManager:
    def setup_method(self):
        self.tmp = tempfile.mkdtemp()
        self.manager = AppArmorManager(profile_dir=self.tmp)

    def test_build_explore_profile_most_restrictive(self):
        """Explore agent should have the most restrictive profile among typed agents."""
        profile = self.manager.build_agent_profile("explore")
        assert profile.name == "paperclip-execution-explore"

        # Minimal capabilities
        capabilities = {c for c in profile.capabilities}
        assert AppArmorCapability.DAC_OVERRIDE in capabilities
        assert AppArmorCapability.KILL in capabilities
        assert AppArmorCapability.NET_ADMIN not in capabilities
        assert AppArmorCapability.SYS_ADMIN not in capabilities

        # Read-only workspace
        fs_text = " ".join(profile.filesystem_rules)
        assert "/workspace/** r" in fs_text or any(
            rule.startswith("/workspace/** r") and " w" not in rule.split()[1]
            if len(rule.split()) > 1
            else rule == "/workspace/** r"
            for rule in profile.filesystem_rules
        )
        # No docker socket
        assert not any("docker.sock" in rule for rule in profile.filesystem_rules)

    def test_build_qa_profile_readonly_workspace(self):
        """QA agent should only read workspace, never write."""
        profile = self.manager.build_agent_profile("qa")
        fs_rules = " ".join(profile.filesystem_rules)
        # Should have read-only workspace — no write perms on workspace
        workspace_rules = [r for r in profile.filesystem_rules if "/workspace/**" in r]
        assert len(workspace_rules) == 1
        # The permission string should not have write
        ws_rule = workspace_rules[0]
        perms = ws_rule.split(maxsplit=1)[1] if len(ws_rule.split(maxsplit=1)) > 1 else ws_rule
        assert "w" not in perms

    def test_build_coder_profile_readwrite_workspace(self):
        """Coder agent should have read-write workspace access."""
        profile = self.manager.build_agent_profile("coder")
        workspace_rules = [r for r in profile.filesystem_rules if "/workspace/**" in r]
        assert len(workspace_rules) == 1
        perms = workspace_rules[0].split(maxsplit=1)[1] if len(workspace_rules[0].split(maxsplit=1)) > 1 else workspace_rules[0]
        assert "w" in perms

        # Should have GitHub and package registry network access
        assert AppArmorNetwork.INET_TCP in profile.network_rules

    def test_build_devops_profile_has_docker_and_cloud(self):
        """DevOps agent should have Docker socket and cloud API access."""
        profile = self.manager.build_agent_profile("devops")
        fs_text = "\n".join(profile.filesystem_rules)

        # Docker socket
        assert "/var/run/docker.sock rw" in fs_text

        # Elevated capabilities
        capabilities = {c.value for c in profile.capabilities}
        assert "net_admin" in capabilities
        assert "sys_admin" in capabilities
        assert "sys_ptrace" in capabilities

        # Full network access
        assert AppArmorNetwork.INET_UDP in profile.network_rules
        assert AppArmorNetwork.NETLINK_RAW in profile.network_rules

    def test_build_securityengineer_profile_has_scanning(self):
        """Security engineer should have scanning tools and packet access."""
        profile = self.manager.build_agent_profile("securityengineer")
        fs_text = "\n".join(profile.filesystem_rules)

        # Scanning tools
        assert "/usr/bin/nmap" in fs_text
        assert "/usr/bin/nikto" in fs_text

        # Raw packet access for scanning
        assert AppArmorNetwork.PACKET_RAW in profile.network_rules

    def test_build_default_profile_fallback(self):
        """Default profile should be maximally restrictive."""
        profile = self.manager.build_default_profile()
        assert profile.name == "paperclip-execution-default"
        assert len(profile.capabilities) == 1
        assert AppArmorCapability.DAC_OVERRIDE in profile.capabilities

        # Read-only, no external network
        net_values = {n.value for n in profile.network_rules}
        assert "inet tcp" not in net_values
        assert "unix stream" in net_values

    def test_get_profile_returns_none_for_unknown(self):
        profile = self.manager.get_profile("bogus_agent")
        assert profile is None

    def test_get_all_profiles_has_all_types(self):
        profiles = self.manager.get_all_profiles()
        assert "default" in profiles
        for agent_type in AGENT_CAPABILITIES:
            assert agent_type in profiles

    def test_write_and_reload_profile(self):
        path = self.manager.write_profile("coder")
        assert path.exists()
        content = path.read_text()
        assert "profile paperclip-execution-coder" in content
        assert "#include <tunables/global>" in content

    def test_write_all_profiles(self):
        paths = self.manager.write_all_profiles()
        agent_count = len(AGENT_CAPABILITIES) + 1  # +1 for default
        assert len(paths) == agent_count
        for p in paths:
            assert p.exists()

    def test_get_docker_security_opts(self):
        opts = self.manager.get_docker_security_opts("explore")
        assert len(opts) >= 1
        assert opts[0].startswith("apparmor=paperclip-execution-explore")

    def test_get_docker_security_opts_fallback_for_unknown(self):
        opts = self.manager.get_docker_security_opts("bogus")
        assert len(opts) >= 1
        assert opts[0] == "apparmor=paperclip-execution-default"

    def test_get_default_docker_security_opt(self):
        opts = self.manager.get_default_docker_security_opt()
        assert len(opts) == 1
        assert opts[0] == "apparmor=paperclip-execution-default"

    def test_all_profiles_include_common_readonly_paths(self):
        for agent_type in AGENT_CAPABILITIES:
            profile = self.manager.build_agent_profile(agent_type)
            for common_path in ["/etc/passwd r", "/dev/null rw", "/dev/urandom r"]:
                assert common_path in profile.filesystem_rules, (
                    f"{agent_type} missing {common_path}"
                )

    def test_all_profiles_deny_dangerous_capabilities(self):
        """No agent should get dangerous capabilities like sys_module or sys_boot."""
        dangerous = {
            AppArmorCapability.SYS_MODULE,
            AppArmorCapability.SYS_BOOT,
            AppArmorCapability.SYS_RAWIO,
            AppArmorCapability.MAC_ADMIN,
            AppArmorCapability.MAC_OVERRIDE,
            AppArmorCapability.SYSLOG,
            AppArmorCapability.AUDIT_CONTROL,
        }
        for agent_type in AGENT_CAPABILITIES:
            profile = self.manager.build_agent_profile(agent_type)
            agent_caps = set(profile.capabilities)
            overlap = dangerous & agent_caps
            assert not overlap, f"{agent_type} has dangerous capabilities: {overlap}"

    def test_devops_is_most_permissive_typed_profile(self):
        """DevOps should have the most capabilities of any typed agent."""
        max_caps = 0
        max_agent = None
        for agent_type in AGENT_CAPABILITIES:
            profile = self.manager.build_agent_profile(agent_type)
            if len(profile.capabilities) > max_caps:
                max_caps = len(profile.capabilities)
                max_agent = agent_type
        assert max_agent == "devops", f"Expected devops to be most permissive, got {max_agent}"

    @patch("subprocess.run")
    def test_load_profile_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        result = self.manager.load_profile("coder")
        assert result is True
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_load_profile_failure(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1)
        result = self.manager.load_profile("coder")
        assert result is False

    @patch("subprocess.run")
    def test_unload_profile(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        result = self.manager.unload_profile("coder")
        assert result is True

    @patch("subprocess.run", side_effect=FileNotFoundError)
    def test_load_profile_parser_not_found(self, mock_run):
        result = self.manager.load_profile("coder")
        assert result is False

    def test_is_profile_loaded_no_sysfs(self):
        with patch("pathlib.Path.exists", return_value=False):
            assert self.manager.is_profile_loaded("coder") is False

    def test_profiles_have_coverage_for_all_agent_capability_sets(self):
        """Every agent type in AGENT_CAPABILITIES must have filesystem and network rules."""
        for agent_type in AGENT_CAPABILITIES:
            assert agent_type in AGENT_FILESYSTEM_RULES, f"Missing FS rules for {agent_type}"
            assert agent_type in AGENT_NETWORK_RULES, f"Missing network rules for {agent_type}"


class TestAppArmorIntegrationWithSandboxManager:
    """Verify that SandboxManager applies AppArmor profiles correctly."""

    @patch("docker.DockerClient")
    def test_apparmor_security_opt_when_manager_provided(self, mock_client_cls):
        from src.container_runtime import SandboxManager
        from src.config import DockerConfig, SandboxConfig, ResourceProfile

        docker_cfg = DockerConfig(
            host="unix:///var/run/docker.sock",
            default_image="sandbox:latest",
            network="test-net",
            pull_policy="never",
        )
        sandbox_cfg = SandboxConfig(
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

        with tempfile.TemporaryDirectory() as tmp:
            apparmor_mgr = AppArmorManager(profile_dir=tmp)
            mgr = SandboxManager(docker_cfg, sandbox_cfg, apparmor_manager=apparmor_mgr)

            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.side_effect = __import__(
                "docker.errors", fromlist=["NotFound"]
            ).NotFound("not found")

            mock_container = MagicMock()
            mock_container.id = "apparmor-test-1"
            mock_client.containers.run.return_value = mock_container

            mgr._client = mock_client

            profile = ResourceProfile(
                cpu_shares=1024, cpu_quota=100000, cpu_period=100000,
                memory_mb=2048, memory_swap_mb=4096, disk_size_gb=10,
                pids_limit=200, description="test",
            )

            mgr.create_container(
                job_id="test-apparmor",
                command="echo hello",
                profile=profile,
                agent_type="coder",
            )

            kwargs = mock_client.containers.run.call_args.kwargs
            security_opts = kwargs.get("security_opt", [])
            assert any("apparmor=" in opt for opt in security_opts)
            assert any("no-new-privileges:true" in opt for opt in security_opts)

    @patch("docker.DockerClient")
    def test_no_apparmor_when_manager_not_provided(self, mock_client_cls):
        from src.container_runtime import SandboxManager
        from src.config import DockerConfig, SandboxConfig, ResourceProfile

        docker_cfg = DockerConfig(
            host="unix:///var/run/docker.sock",
            default_image="sandbox:latest",
            network="test-net",
            pull_policy="never",
        )
        sandbox_cfg = SandboxConfig(
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

        mgr = SandboxManager(docker_cfg, sandbox_cfg)  # No AppArmor

        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_client.ping.return_value = True
        mock_client.networks.get.side_effect = __import__(
            "docker.errors", fromlist=["NotFound"]
        ).NotFound("not found")

        mock_container = MagicMock()
        mock_container.id = "no-apparmor-1"
        mock_client.containers.run.return_value = mock_container

        mgr._client = mock_client

        profile = ResourceProfile(
            cpu_shares=1024, cpu_quota=100000, cpu_period=100000,
            memory_mb=2048, memory_swap_mb=4096, disk_size_gb=10,
            pids_limit=200, description="test",
        )

        mgr.create_container(
            job_id="test-no-apparmor",
            command="echo hello",
            profile=profile,
        )

        kwargs = mock_client.containers.run.call_args.kwargs
        security_opts = kwargs.get("security_opt", [])
        assert not any("apparmor=" in opt for opt in security_opts)
        assert any("no-new-privileges:true" in opt for opt in security_opts)

    @patch("docker.DockerClient")
    def test_apparmor_fallback_to_default_for_unknown_agent_type(self, mock_client_cls):
        from src.container_runtime import SandboxManager
        from src.config import DockerConfig, SandboxConfig, ResourceProfile

        docker_cfg = DockerConfig(
            host="unix:///var/run/docker.sock",
            default_image="sandbox:latest",
            network="test-net",
            pull_policy="never",
        )
        sandbox_cfg = SandboxConfig(
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

        with tempfile.TemporaryDirectory() as tmp:
            apparmor_mgr = AppArmorManager(profile_dir=tmp)
            mgr = SandboxManager(docker_cfg, sandbox_cfg, apparmor_manager=apparmor_mgr)

            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ping.return_value = True
            mock_client.networks.get.side_effect = __import__(
                "docker.errors", fromlist=["NotFound"]
            ).NotFound("not found")

            mock_container = MagicMock()
            mock_container.id = "fallback-1"
            mock_client.containers.run.return_value = mock_container

            mgr._client = mock_client

            profile = ResourceProfile(
                cpu_shares=1024, cpu_quota=100000, cpu_period=100000,
                memory_mb=2048, memory_swap_mb=4096, disk_size_gb=10,
                pids_limit=200, description="test",
            )

            mgr.create_container(
                job_id="test-fallback",
                command="echo hello",
                profile=profile,
                agent_type="nonexistent_agent",
            )

            kwargs = mock_client.containers.run.call_args.kwargs
            security_opts = kwargs.get("security_opt", [])
            apparmor_opts = [o for o in security_opts if "apparmor=" in o]
            assert len(apparmor_opts) == 1
            assert "paperclip-execution-default" in apparmor_opts[0]
