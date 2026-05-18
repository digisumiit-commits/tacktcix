"""Scoped permissions engine for agent capability enforcement.

Implements explicit capability allowlisting per agent type.
Every permission check is deny-by-default: if the capability is not
explicitly granted, it is denied.
"""

import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional


class PermissionResult(str, Enum):
    ALLOWED = "allowed"
    DENIED = "denied"
    UNKNOWN_CAPABILITY = "unknown_capability"


@dataclass
class PermissionCheck:
    agent_id: str
    agent_type: str
    capability: str
    resource: Optional[str] = None
    result: PermissionResult = PermissionResult.DENIED
    reason: str = ""


@dataclass
class CommandCheck:
    command: str
    allowed: bool = False
    matched_pattern: Optional[str] = None


class PermissionsEngine:
    """Deny-by-default capability engine.

    Each agent type maps to an explicit capability allowlist.
    Commands are validated against safe/blocked pattern lists.
    """

    def __init__(
        self,
        agent_capabilities: dict[str, list[str]],
        default_capabilities: Optional[list[str]] = None,
        safe_command_patterns: Optional[list[str]] = None,
        blocked_command_patterns: Optional[list[str]] = None,
    ):
        self.agent_capabilities = agent_capabilities
        self.default_capabilities = default_capabilities or []

        self.safe_patterns: list[re.Pattern] = []
        if safe_command_patterns:
            self.safe_patterns = [re.compile(p) for p in safe_command_patterns]

        self.blocked_patterns: list[re.Pattern] = []
        if blocked_command_patterns:
            self.blocked_patterns = [re.compile(p) for p in blocked_command_patterns]

    def get_capabilities(self, agent_type: str) -> set[str]:
        """Get the full capability set for an agent type."""
        explicit = set(self.agent_capabilities.get(agent_type, []))
        default = set(self.default_capabilities)
        return explicit | default

    def check_capability(
        self,
        agent_type: str,
        agent_id: str,
        capability: str,
        resource: Optional[str] = None,
    ) -> PermissionCheck:
        """Check if an agent has a specific capability."""
        capabilities = self.get_capabilities(agent_type)

        check = PermissionCheck(
            agent_id=agent_id,
            agent_type=agent_type,
            capability=capability,
            resource=resource,
        )

        if capability in capabilities:
            check.result = PermissionResult.ALLOWED
            check.reason = f"Capability '{capability}' granted to agent type '{agent_type}'"
        else:
            check.result = PermissionResult.DENIED
            check.reason = f"Capability '{capability}' not in allowlist for agent type '{agent_type}'"

        return check

    def verify_capability(
        self,
        agent_type: str,
        agent_id: str,
        capability: str,
        resource: Optional[str] = None,
    ) -> PermissionCheck:
        """Check a capability and return the result. Never raises."""
        return self.check_capability(agent_type, agent_id, capability, resource)

    def require_capability(
        self,
        agent_type: str,
        agent_id: str,
        capability: str,
        resource: Optional[str] = None,
    ) -> PermissionCheck:
        """Check a capability. Raises PermissionError if denied."""
        check = self.check_capability(agent_type, agent_id, capability, resource)
        if check.result != PermissionResult.ALLOWED:
            raise PermissionError(check.reason)
        return check

    def check_command(self, command: str) -> CommandCheck:
        """Validate a shell command against allow/block lists.

        Blocked patterns take precedence over safe patterns.
        """
        stripped = command.strip()

        # Check blocked patterns first (precedence)
        for pattern in self.blocked_patterns:
            if pattern.search(stripped):
                return CommandCheck(command=stripped, allowed=False, matched_pattern=pattern.pattern)

        # Check safe patterns
        for pattern in self.safe_patterns:
            if pattern.search(stripped):
                return CommandCheck(command=stripped, allowed=True, matched_pattern=pattern.pattern)

        # No match = blocked (deny-by-default)
        return CommandCheck(command=stripped, allowed=False)

    def is_command_allowed(self, command: str) -> bool:
        """Quick check if a command is allowed."""
        return self.check_command(command).allowed

    def validate_network_access(
        self,
        agent_type: str,
        agent_id: str,
        target: str,
    ) -> PermissionCheck:
        """Validate whether an agent can access a network target."""
        capability_prefix = "net.outbound_"
        capabilities = self.get_capabilities(agent_type)

        # Check for wildcard network access first (powerful capability)
        if "net.outbound_all" in capabilities:
            return PermissionCheck(
                agent_id=agent_id,
                agent_type=agent_type,
                capability="net.outbound_all",
                resource=target,
                result=PermissionResult.ALLOWED,
                reason="Wildcard network access granted",
            )

        # Check specific network capability categories
        net_caps = {c for c in capabilities if c.startswith(capability_prefix)}
        for cap in net_caps:
            category = cap[len(capability_prefix):]
            if category == "github" and ("github.com" in target or "github" in target):
                return PermissionCheck(
                    agent_id=agent_id, agent_type=agent_type,
                    capability=cap, resource=target,
                    result=PermissionResult.ALLOWED,
                )

        # Default deny
        return PermissionCheck(
            agent_id=agent_id,
            agent_type=agent_type,
            capability="net.outbound",
            resource=target,
            result=PermissionResult.DENIED,
            reason=f"No network capability allows access to {target}",
        )
