"""Per-container network egress filtering via iptables/nftables.

Enforces allowlist-based outbound traffic for execution containers.
Reads egress rules from security.yaml and maps agent network capabilities
to allowed CIDR ranges. Default policy: deny all outbound.

Rule application flow:
1. Container created with NET_ADMIN + NET_RAW retained
2. iptables rules applied via docker exec (root) before job starts
3. DNS restricted to approved servers only
4. All outbound traffic blocked except allowed CIDRs and established flows
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import structlog

from .config import NetworkEgressConfig

logger = structlog.get_logger(__name__)

CAPABILITY_TO_CATEGORY: dict[str, str] = {
    "net.outbound_github": "github",
    "net.outbound_pypi": "pypi",
    "net.outbound_npm": "npm",
    "net.outbound_docker_registry": "docker_registry",
    "net.outbound_cloud_apis": "cloud_apis",
    "net.outbound_test_endpoints": "test_endpoints",
    "net.outbound_scan_targets": "scan_targets",
}

# Well-known CIDRs for domain-based egress rules.
# These supplement the config when domains need IP resolution.
_KNOWN_REGISTRY_CIDRS: list[str] = [
    # Docker Hub registry (docker.io)
    "44.205.64.0/20",
    "54.85.0.0/16",
    "34.192.0.0/12",
    "3.224.0.0/12",
    # GitHub Container Registry (ghcr.io)
    "140.82.112.0/20",
]

# AWS Cloud API CIDRs (us-east-1 as default; extend per region)
_KNOWN_CLOUD_API_CIDRS: list[str] = [
    "54.160.0.0/13",
    "54.208.0.0/15",
    "52.0.0.0/15",
    "3.208.0.0/13",
    "18.232.0.0/14",
    "44.192.0.0/11",
]

# GCP Cloud API CIDRs
_KNOWN_GCP_API_CIDRS: list[str] = [
    "8.34.208.0/20",
    "8.35.192.0/21",
    "8.35.200.0/23",
    "108.170.192.0/18",
    "108.177.0.0/17",
]


@dataclass(frozen=True)
class EgressPolicy:
    """Resolved egress policy for a single container execution."""

    allowed_cidrs: tuple[str, ...]
    dns_servers: tuple[str, ...]
    default_policy: str


class NetworkEgressManager:
    """Manages iptables-based egress filtering for execution containers.

    Translates agent network capabilities into iptables rule sets and
    applies them inside the container's network namespace via docker exec.
    """

    def __init__(self, config: NetworkEgressConfig) -> None:
        self._config = config
        self._iptables_bin = "iptables"

    @property
    def dns_servers(self) -> list[str]:
        return list(self._config.dns_servers)

    @property
    def default_policy(self) -> str:
        return self._config.default_policy

    def resolve_policy(
        self,
        agent_capabilities: list[str] | set[str],
    ) -> EgressPolicy:
        """Resolve allowed CIDRs and DNS servers for a set of agent capabilities.

        Returns an EgressPolicy with the union of all matching egress rules.
        If no network capabilities are present, returns an empty allowlist
        (all outbound denied except loopback).
        """
        caps = set(agent_capabilities) if isinstance(agent_capabilities, list) else set(agent_capabilities)

        # Wildcard: allow all outbound
        if "net.outbound_all" in caps:
            return EgressPolicy(
                allowed_cidrs=("0.0.0.0/0",),
                dns_servers=tuple(self._config.dns_servers),
                default_policy=self._config.default_policy,
            )

        allowed_cidrs: list[str] = []
        seen_categories: set[str] = set()

        for cap in caps:
            category = CAPABILITY_TO_CATEGORY.get(cap)
            if category is None or category in seen_categories:
                continue
            seen_categories.add(category)

            cidrs = self._resolve_category_cidrs(category)
            allowed_cidrs.extend(cidrs)

        # Deduplicate
        unique_cidrs = sorted(set(allowed_cidrs))
        return EgressPolicy(
            allowed_cidrs=tuple(unique_cidrs),
            dns_servers=tuple(self._config.dns_servers),
            default_policy=self._config.default_policy,
        )

    def _resolve_category_cidrs(self, category: str) -> list[str]:
        """Resolve a rule category to CIDR list.

        Falls back to known CIDRs for domain-based categories.
        """
        rules = self._config.egress_rules.get(category, [])

        cidrs: list[str] = []
        for entry in rules:
            entry = entry.strip()
            if self._is_cidr(entry):
                cidrs.append(entry)
            elif category == "docker_registry":
                cidrs.extend(_KNOWN_REGISTRY_CIDRS)
            elif category == "cloud_apis":
                cidrs.extend(_KNOWN_CLOUD_API_CIDRS)
                cidrs.extend(_KNOWN_GCP_API_CIDRS)

        return cidrs

    @staticmethod
    def _is_cidr(entry: str) -> bool:
        return bool(re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}$", entry))

    def build_rules_script(
        self,
        policy: EgressPolicy,
    ) -> str:
        """Generate the iptables rule script to apply inside the container.

        Returns a bash script string that:
        - Sets default DROP on OUTPUT chain
        - Allows loopback
        - Allows established/related inbound traffic
        - Allows DNS to approved servers (UDP + TCP port 53)
        - Allows outbound to approved CIDRs
        """
        ipt = self._iptables_bin
        lines: list[str] = [
            "#!/usr/bin/env bash",
            "set -e",
            "# Network egress policy — generated by NetworkEgressManager",
            "# Default policy: deny all outbound",
            "",
            f"{ipt} -F OUTPUT 2>/dev/null || true",
            f"{ipt} -P OUTPUT DROP",
            "",
            "# Allow loopback",
            f"{ipt} -A OUTPUT -o lo -j ACCEPT",
            "",
            "# Allow established/related traffic",
            f"{ipt} -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
            "",
            "# DNS: only approved servers",
        ]

        for dns in policy.dns_servers:
            lines.append(f"{ipt} -A OUTPUT -p udp --dport 53 -d {dns} -j ACCEPT")
            lines.append(f"{ipt} -A OUTPUT -p tcp --dport 53 -d {dns} -j ACCEPT")

        lines.append("")
        lines.append("# Allowed egress CIDRs")

        if not policy.allowed_cidrs:
            lines.append("# (none — all outbound blocked)")

        for cidr in policy.allowed_cidrs:
            if cidr == "0.0.0.0/0":
                # Allow-all overrides default deny
                lines.append(f"{ipt} -P OUTPUT ACCEPT")
                lines.append("# Allow-all CIDR — default policy set to ACCEPT")
                break
            lines.append(f"{ipt} -A OUTPUT -d {cidr} -j ACCEPT")

        return "\n".join(lines) + "\n"

    def apply_to_container(
        self,
        container_id: str,
        policy: EgressPolicy,
        docker_client,
    ) -> bool:
        """Apply egress rules to a running container via docker exec.

        Executes the iptables rule script inside the container as root.
        The container must have NET_ADMIN capability retained.

        Returns True on success, False on failure.
        """
        script = self.build_rules_script(policy)

        try:
            exec_result = docker_client.exec_run(
                container_id,
                cmd=["/bin/bash", "-c", script],
                user="root",
                privileged=False,
            )
            if exec_result.exit_code == 0:
                logger.info(
                    "egress_rules_applied",
                    container_id=container_id,
                    cidr_count=len(policy.allowed_cidrs),
                    dns_servers=list(policy.dns_servers),
                )
                return True
            else:
                logger.error(
                    "egress_rules_failed",
                    container_id=container_id,
                    exit_code=exec_result.exit_code,
                    stderr=exec_result.output.decode(errors="replace")[:500],
                )
                return False
        except Exception:
            logger.exception(
                "egress_rules_exception",
                container_id=container_id,
            )
            return False

    def verify_rules(self, container_id: str, docker_client) -> bool:
        """Verify that OUTPUT chain DROP policy is in effect.

        Returns True if the policy is confirmed active.
        """
        try:
            exec_result = docker_client.exec_run(
                container_id,
                cmd=["iptables", "-L", "OUTPUT", "-n"],
                user="root",
            )
            output = exec_result.output.decode(errors="replace")
            has_drop = "DROP" in output.split("\n")[0] if output else False
            if not has_drop:
                logger.warning(
                    "egress_verification_failed",
                    container_id=container_id,
                    output=output[:300],
                )
            return has_drop
        except Exception:
            return False
