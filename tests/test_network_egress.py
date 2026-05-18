"""Tests for network egress policy enforcement (PRO-34)."""

import pytest
from unittest.mock import MagicMock, patch

from src.network_egress import (
    NetworkEgressManager,
    EgressPolicy,
    CAPABILITY_TO_CATEGORY,
)
from src.config import NetworkEgressConfig


def make_config(**overrides) -> NetworkEgressConfig:
    defaults = {
        "default_policy": "deny",
        "egress_rules": {
            "github": ["140.82.112.0/20", "185.199.108.0/22"],
            "pypi": ["151.101.0.0/16", "151.101.64.0/16"],
            "npm": ["104.16.0.0/12"],
            "docker_registry": ["docker.io", "ghcr.io"],
            "cloud_apis": ["aws:*.amazonaws.com"],
            "test_endpoints": ["0.0.0.0/0"],
            "scan_targets": ["0.0.0.0/0"],
        },
        "dns_servers": ["8.8.8.8", "1.1.1.1"],
        "dns_search_domains": [],
    }
    defaults.update(overrides)
    return NetworkEgressConfig(**defaults)


class TestNetworkEgressConfig:
    def test_default_policy_is_deny(self):
        cfg = make_config()
        assert cfg.default_policy == "deny"

    def test_dns_servers_configured(self):
        cfg = make_config()
        assert "8.8.8.8" in cfg.dns_servers
        assert "1.1.1.1" in cfg.dns_servers

    def test_egress_rules_have_expected_categories(self):
        cfg = make_config()
        assert "github" in cfg.egress_rules
        assert "pypi" in cfg.egress_rules
        assert "npm" in cfg.egress_rules
        assert "docker_registry" in cfg.egress_rules
        assert "cloud_apis" in cfg.egress_rules


class TestNetworkEgressManagerResolvePolicy:
    def setup_method(self):
        self.config = make_config()
        self.mgr = NetworkEgressManager(self.config)

    def test_no_capabilities_results_in_empty_allowlist(self):
        policy = self.mgr.resolve_policy([])
        assert policy.allowed_cidrs == ()
        assert policy.default_policy == "deny"

    def test_github_capability_resolves_cidrs(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        assert "140.82.112.0/20" in policy.allowed_cidrs
        assert "185.199.108.0/22" in policy.allowed_cidrs

    def test_pypi_capability_resolves_cidrs(self):
        policy = self.mgr.resolve_policy(["net.outbound_pypi"])
        assert "151.101.0.0/16" in policy.allowed_cidrs
        assert "151.101.64.0/16" in policy.allowed_cidrs

    def test_npm_capability_resolves_cidrs(self):
        policy = self.mgr.resolve_policy(["net.outbound_npm"])
        assert "104.16.0.0/12" in policy.allowed_cidrs

    def test_multiple_capabilities_union(self):
        policy = self.mgr.resolve_policy(
            ["net.outbound_github", "net.outbound_pypi"]
        )
        assert "140.82.112.0/20" in policy.allowed_cidrs
        assert "151.101.0.0/16" in policy.allowed_cidrs

    def test_allow_all_policy(self):
        policy = self.mgr.resolve_policy(["net.outbound_all"])
        assert "0.0.0.0/0" in policy.allowed_cidrs

    def test_test_endpoints_allow_all(self):
        policy = self.mgr.resolve_policy(["net.outbound_test_endpoints"])
        assert "0.0.0.0/0" in policy.allowed_cidrs

    def test_scan_targets_allow_all(self):
        policy = self.mgr.resolve_policy(["net.outbound_scan_targets"])
        assert "0.0.0.0/0" in policy.allowed_cidrs

    def test_docker_registry_includes_known_cidrs(self):
        policy = self.mgr.resolve_policy(["net.outbound_docker_registry"])
        assert len(policy.allowed_cidrs) > 0
        # Should include known Docker registry / GHCR CIDRs
        assert any("44.205" in c or "140.82" in c for c in policy.allowed_cidrs)

    def test_cloud_apis_includes_known_cidrs(self):
        policy = self.mgr.resolve_policy(["net.outbound_cloud_apis"])
        assert len(policy.allowed_cidrs) > 0

    def test_dns_servers_always_included(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        assert "8.8.8.8" in policy.dns_servers
        assert "1.1.1.1" in policy.dns_servers

    def test_unknown_capability_ignored(self):
        policy = self.mgr.resolve_policy(["net.outbound_unknown", "net.outbound_github"])
        assert "140.82.112.0/20" in policy.allowed_cidrs

    def test_deduplication_of_cidrs(self):
        policy = self.mgr.resolve_policy(
            ["net.outbound_github", "net.outbound_github"]
        )
        # Each CIDR should appear only once
        assert policy.allowed_cidrs.count("140.82.112.0/20") == 1

    def test_set_input_accepted(self):
        policy = self.mgr.resolve_policy({"net.outbound_github"})
        assert "140.82.112.0/20" in policy.allowed_cidrs

    def test_egress_policy_is_frozen(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        # EgressPolicy is a frozen dataclass — cannot set attributes
        with pytest.raises(Exception):
            policy.allowed_cidrs = ("1.2.3.4/32",)  # type: ignore[misc]
        # allowed_cidrs is a tuple — immutable sequence
        assert isinstance(policy.allowed_cidrs, tuple)


class TestBuildRulesScript:
    def setup_method(self):
        self.config = make_config()
        self.mgr = NetworkEgressManager(self.config)

    def test_script_includes_iptables_binary(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert "iptables" in script

    def test_script_sets_default_drop(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert "-P OUTPUT DROP" in script

    def test_script_allows_loopback(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert "-o lo -j ACCEPT" in script

    def test_script_allows_established(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert "ESTABLISHED" in script

    def test_script_allows_dns_servers(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert "-d 8.8.8.8" in script
        assert "-d 1.1.1.1" in script
        assert "--dport 53" in script

    def test_script_includes_allowed_cidrs(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert "140.82.112.0/20" in script

    def test_script_empty_allowlist(self):
        policy = self.mgr.resolve_policy([])
        script = self.mgr.build_rules_script(policy)
        assert "all outbound blocked" in script.lower()

    def test_allow_all_sets_accept_policy(self):
        policy = self.mgr.resolve_policy(["net.outbound_all"])
        script = self.mgr.build_rules_script(policy)
        assert "-P OUTPUT ACCEPT" in script

    def test_script_is_executable_syntax(self):
        policy = self.mgr.resolve_policy(["net.outbound_github"])
        script = self.mgr.build_rules_script(policy)
        assert script.startswith("#!/usr/bin/env bash")
        assert "set -e" in script


class TestApplyToContainer:
    def setup_method(self):
        self.config = make_config()
        self.mgr = NetworkEgressManager(self.config)
        self.policy = self.mgr.resolve_policy(["net.outbound_github"])

    def test_apply_success(self):
        mock_client = MagicMock()
        mock_result = MagicMock()
        mock_result.exit_code = 0
        mock_client.exec_run.return_value = mock_result

        result = self.mgr.apply_to_container("abc123", self.policy, mock_client)
        assert result is True
        mock_client.exec_run.assert_called_once()

    def test_apply_failure_on_nonzero_exit(self):
        mock_client = MagicMock()
        mock_result = MagicMock()
        mock_result.exit_code = 1
        mock_result.output = b"iptables: Permission denied"
        mock_client.exec_run.return_value = mock_result

        result = self.mgr.apply_to_container("abc123", self.policy, mock_client)
        assert result is False

    def test_apply_failure_on_exception(self):
        mock_client = MagicMock()
        mock_client.exec_run.side_effect = RuntimeError("Docker unavailable")

        result = self.mgr.apply_to_container("abc123", self.policy, mock_client)
        assert result is False

    def test_apply_runs_as_root(self):
        mock_client = MagicMock()
        mock_result = MagicMock()
        mock_result.exit_code = 0
        mock_client.exec_run.return_value = mock_result

        self.mgr.apply_to_container("abc123", self.policy, mock_client)
        call_kwargs = mock_client.exec_run.call_args.kwargs
        assert call_kwargs["user"] == "root"

    def test_verify_rules_detects_drop(self):
        mock_client = MagicMock()
        mock_result = MagicMock()
        mock_result.exit_code = 0
        mock_result.output = b"Chain OUTPUT (policy DROP)\ntarget     prot opt source               destination"
        mock_client.exec_run.return_value = mock_result

        assert self.mgr.verify_rules("abc123", mock_client) is True

    def test_verify_rules_detects_non_drop(self):
        mock_client = MagicMock()
        mock_result = MagicMock()
        mock_result.exit_code = 0
        mock_result.output = b"Chain OUTPUT (policy ACCEPT)\ntarget     prot opt source               destination"
        mock_client.exec_run.return_value = mock_result

        assert self.mgr.verify_rules("abc123", mock_client) is False


class TestCapabilityMapping:
    def test_all_expected_categories_mapped(self):
        expected = {
            "net.outbound_github",
            "net.outbound_pypi",
            "net.outbound_npm",
            "net.outbound_docker_registry",
            "net.outbound_cloud_apis",
            "net.outbound_test_endpoints",
            "net.outbound_scan_targets",
        }
        assert set(CAPABILITY_TO_CATEGORY.keys()) == expected

    def test_category_values_are_valid(self):
        valid_categories = {
            "github", "pypi", "npm", "docker_registry",
            "cloud_apis", "test_endpoints", "scan_targets",
        }
        assert set(CAPABILITY_TO_CATEGORY.values()) <= valid_categories
