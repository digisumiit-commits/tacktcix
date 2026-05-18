"""AppArmor profile management for per-agent-type execution sandboxing.

Generates AppArmor profiles that complement seccomp filtering with
filesystem restrictions, Linux capability limits, and network constraints
enforced at the LSM level. Each agent type (coder, devops, qa,
securityengineer, explore) gets a tailored profile built from the
security.yaml permissions model.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


class AppArmorCapability(str, Enum):
    """Linux capabilities relevant to AppArmor profile rules."""
    CHOWN = "chown"
    DAC_OVERRIDE = "dac_override"
    DAC_READ_SEARCH = "dac_read_search"
    FOWNER = "fowner"
    FSETID = "fsetid"
    KILL = "kill"
    SETGID = "setgid"
    SETUID = "setuid"
    SETPCAP = "setpcap"
    LINUX_IMMUTABLE = "linux_immutable"
    NET_BIND_SERVICE = "net_bind_service"
    NET_BROADCAST = "net_broadcast"
    NET_ADMIN = "net_admin"
    NET_RAW = "net_raw"
    IPC_LOCK = "ipc_lock"
    IPC_OWNER = "ipc_owner"
    SYS_MODULE = "sys_module"
    SYS_RAWIO = "sys_rawio"
    SYS_CHROOT = "sys_chroot"
    SYS_PTRACE = "sys_ptrace"
    SYS_PACCT = "sys_pacct"
    SYS_ADMIN = "sys_admin"
    SYS_BOOT = "sys_boot"
    SYS_NICE = "sys_nice"
    SYS_RESOURCE = "sys_resource"
    SYS_TIME = "sys_time"
    SYS_TTY_CONFIG = "sys_tty_config"
    MKNOD = "mknod"
    LEASE = "lease"
    AUDIT_WRITE = "audit_write"
    AUDIT_CONTROL = "audit_control"
    SETFCAP = "setfcap"
    MAC_OVERRIDE = "mac_override"
    MAC_ADMIN = "mac_admin"
    SYSLOG = "syslog"
    WAKE_ALARM = "wake_alarm"
    BLOCK_SUSPEND = "block_suspend"
    AUDIT_READ = "audit_read"
    PERFMON = "perfmon"
    BPF = "bpf"
    CHECKPOINT_RESTORE = "checkpoint_restore"


class AppArmorNetwork(str, Enum):
    """AppArmor network domain types."""
    INET_TCP = "inet tcp"
    INET_UDP = "inet udp"
    INET6_TCP = "inet6 tcp"
    INET6_UDP = "inet6 udp"
    UNIX_STREAM = "unix stream"
    UNIX_DGRAM = "unix dgram"
    NETLINK_RAW = "netlink raw"
    PACKET_RAW = "packet raw"


# Per-agent-type capability mappings derived from security.yaml permissions.
# These are the MINIMAL Linux capabilities each agent type requires.
AGENT_CAPABILITIES: dict[str, list[AppArmorCapability]] = {
    "coder": [
        AppArmorCapability.DAC_OVERRIDE,
        AppArmorCapability.FOWNER,
        AppArmorCapability.FSETID,
        AppArmorCapability.SETUID,
        AppArmorCapability.SETGID,
        AppArmorCapability.CHOWN,
        AppArmorCapability.KILL,
        AppArmorCapability.SETPCAP,
    ],
    "devops": [
        AppArmorCapability.DAC_OVERRIDE,
        AppArmorCapability.FOWNER,
        AppArmorCapability.FSETID,
        AppArmorCapability.SETUID,
        AppArmorCapability.SETGID,
        AppArmorCapability.CHOWN,
        AppArmorCapability.KILL,
        AppArmorCapability.SETPCAP,
        AppArmorCapability.NET_ADMIN,
        AppArmorCapability.NET_RAW,
        AppArmorCapability.SYS_ADMIN,
        AppArmorCapability.SYS_PTRACE,
        AppArmorCapability.SYS_CHROOT,
    ],
    "qa": [
        AppArmorCapability.DAC_OVERRIDE,
        AppArmorCapability.KILL,
    ],
    "securityengineer": [
        AppArmorCapability.DAC_OVERRIDE,
        AppArmorCapability.FOWNER,
        AppArmorCapability.FSETID,
        AppArmorCapability.SETUID,
        AppArmorCapability.SETGID,
        AppArmorCapability.CHOWN,
        AppArmorCapability.KILL,
        AppArmorCapability.NET_RAW,
        AppArmorCapability.SYS_PTRACE,
        AppArmorCapability.SYS_ADMIN,
    ],
    "explore": [
        AppArmorCapability.DAC_OVERRIDE,
        AppArmorCapability.KILL,
    ],
}

# Per-agent-type filesystem rules. All paths are relative to the container.
# r = read, w = write, m = mmap (exec), l = link, k = lock, a = append
AGENT_FILESYSTEM_RULES: dict[str, list[str]] = {
    "coder": [
        "/workspace/** rwmlk",
        "/tmp/** rwmlk",
        "/run/** rwmlk",
        "/home/executor/** rwmlk",
        "/usr/bin/git mrix",
        "/usr/bin/python* mrix",
        "/usr/bin/node mrix",
        "/usr/bin/npm mrix",
        "/usr/bin/npx mrix",
        "/usr/bin/pip* mrix",
        "/usr/bin/poetry mrix",
        "/usr/bin/cargo mrix",
        "/usr/bin/go mrix",
        "/usr/bin/curl mrix",
        "/usr/bin/wget mrix",
        "/usr/bin/gh mrix",
        "/usr/bin/make mrix",
        "/usr/bin/gcc mrix",
        "/usr/bin/g++ mrix",
    ],
    "devops": [
        "/workspace/** rwmlk",
        "/tmp/** rwmlk",
        "/run/** rwmlk",
        "/home/executor/** rwmlk",
        "/usr/bin/git mrix",
        "/usr/bin/python* mrix",
        "/usr/bin/node mrix",
        "/usr/bin/npm mrix",
        "/usr/bin/curl mrix",
        "/usr/bin/wget mrix",
        "/usr/bin/gh mrix",
        "/usr/bin/docker mrix",
        "/usr/bin/kubectl mrix",
        "/usr/bin/make mrix",
        "/var/run/docker.sock rw",
        "/root/.docker/config.json r",
    ],
    "qa": [
        "/workspace/** r",
        "/tmp/** r",
        "/run/** r",
        "/home/executor/** r",
        "/usr/bin/python* mrix",
        "/usr/bin/node mrix",
        "/usr/bin/curl mrix",
        "/usr/bin/wget mrix",
    ],
    "securityengineer": [
        "/workspace/** rwmlk",
        "/tmp/** rwmlk",
        "/run/** rwmlk",
        "/home/executor/** rwmlk",
        "/usr/bin/git mrix",
        "/usr/bin/python* mrix",
        "/usr/bin/node mrix",
        "/usr/bin/curl mrix",
        "/usr/bin/wget mrix",
        "/usr/bin/nmap mrix",
        "/usr/bin/nikto mrix",
        "/usr/bin/gobuster mrix",
        "/usr/bin/sqlmap mrix",
        "/usr/bin/gh mrix",
    ],
    "explore": [
        "/workspace/** r",
        "/tmp/** r",
        "/run/** r",
        "/home/executor/** r",
        "/usr/bin/git mrix",
        "/usr/bin/python* mrix",
        "/usr/bin/node mrix",
        "/usr/bin/curl mrix",
        "/usr/bin/gh mrix",
    ],
}

# Per-agent-type network rules. Maps to net.outbound_* capabilities from security.yaml.
AGENT_NETWORK_RULES: dict[str, list[AppArmorNetwork]] = {
    "coder": [
        AppArmorNetwork.INET_TCP,
        AppArmorNetwork.INET6_TCP,
        AppArmorNetwork.UNIX_STREAM,
        AppArmorNetwork.UNIX_DGRAM,
    ],
    "devops": [
        AppArmorNetwork.INET_TCP,
        AppArmorNetwork.INET_UDP,
        AppArmorNetwork.INET6_TCP,
        AppArmorNetwork.INET6_UDP,
        AppArmorNetwork.UNIX_STREAM,
        AppArmorNetwork.UNIX_DGRAM,
        AppArmorNetwork.NETLINK_RAW,
    ],
    "qa": [
        AppArmorNetwork.INET_TCP,
        AppArmorNetwork.INET6_TCP,
        AppArmorNetwork.UNIX_STREAM,
        AppArmorNetwork.UNIX_DGRAM,
    ],
    "securityengineer": [
        AppArmorNetwork.INET_TCP,
        AppArmorNetwork.INET_UDP,
        AppArmorNetwork.INET6_TCP,
        AppArmorNetwork.INET6_UDP,
        AppArmorNetwork.UNIX_STREAM,
        AppArmorNetwork.UNIX_DGRAM,
        AppArmorNetwork.PACKET_RAW,
    ],
    "explore": [
        AppArmorNetwork.INET_TCP,
        AppArmorNetwork.INET6_TCP,
        AppArmorNetwork.UNIX_STREAM,
        AppArmorNetwork.UNIX_DGRAM,
    ],
}

# Filesystem abstractions included by default in all profiles
BASE_ABSTRACTIONS: list[str] = [
    "base",
    "nameservice",
    "ssl_certs",
    "crypto",
]

# Common read-only paths all agents need
COMMON_READONLY_PATHS: list[str] = [
    "/etc/passwd r",
    "/etc/group r",
    "/etc/nsswitch.conf r",
    "/etc/resolv.conf r",
    "/etc/hosts r",
    "/etc/hostname r",
    "/etc/ssl/** r",
    "/usr/lib/** r",
    "/usr/share/** r",
    "/lib/** r",
    "/lib64/** r",
    "/proc/*/status r",
    "/proc/*/mounts r",
    "/proc/filesystems r",
    "/proc/sys/kernel/ngroups_max r",
    "/sys/devices/system/cpu/** r",
    "/dev/null rw",
    "/dev/zero rw",
    "/dev/random r",
    "/dev/urandom r",
    "/dev/stdin r",
    "/dev/stdout w",
    "/dev/stderr w",
]

# Paths explicitly denied for all agent types (defense in depth)
ALWAYS_DENY_PATHS: list[str] = [
    "/boot/**",
    "/root/**",
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/sudoers.d/**",
    "/etc/apparmor/**",
    "/etc/apparmor.d/**",
    "/sys/kernel/security/**",
    "/proc/sysrq-trigger",
    "/proc/kcore",
    "/proc/kallsyms",
    "/proc/sys/kernel/**",
]


@dataclass
class AppArmorProfile:
    """An AppArmor profile with filesystem, capability, and network rules."""

    name: str
    capabilities: list[AppArmorCapability] = field(default_factory=list)
    filesystem_rules: list[str] = field(default_factory=list)
    network_rules: list[AppArmorNetwork] = field(default_factory=list)
    comment: str = ""

    def generate(self) -> str:
        """Generate the full AppArmor profile text."""
        lines: list[str] = []

        lines.append(f"#include <tunables/global>")
        lines.append("")

        if self.comment:
            for comment_line in self.comment.strip().split("\n"):
                lines.append(f"# {comment_line.strip()}")
            lines.append("")

        flags = "flags=(attach_disconnected,mediate_deleted)"
        lines.append(f"profile {self.name} {flags} {{")

        # Include base abstractions
        for abstraction in BASE_ABSTRACTIONS:
            lines.append(f"  #include <abstractions/{abstraction}>")

        # Capability rules
        if self.capabilities:
            lines.append("")
            lines.append("  # Linux capabilities")
            for cap in sorted(self.capabilities, key=lambda c: c.value):
                lines.append(f"  capability {cap.value},")
            # Explicitly deny all other capabilities
            lines.append("  deny capability,")

        # Filesystem rules
        if self.filesystem_rules:
            lines.append("")
            lines.append("  # Filesystem access")
            for rule in self.filesystem_rules:
                lines.append(f"  {rule},")

        # Always-deny paths
        if ALWAYS_DENY_PATHS:
            lines.append("")
            lines.append("  # Explicitly denied paths")
            for rule in ALWAYS_DENY_PATHS:
                lines.append(f"  deny {rule},")

        # Network rules
        if self.network_rules:
            lines.append("")
            lines.append("  # Network access")
            for net in sorted(self.network_rules, key=lambda n: n.value):
                lines.append(f"  network {net.value},")
            # Deny all other network types
            lines.append("  deny network,")

        # Signal and ptrace restrictions
        lines.append("")
        lines.append("  # Signal and ptrace restrictions")
        lines.append("  signal (receive) peer=unconfined,")
        lines.append("  signal (send) peer={self.name},")
        lines.append("  deny ptrace (readby) peer=unconfined,")
        lines.append("  deny ptrace (tracedby) peer=unconfined,")

        # Default deny for everything not explicitly allowed
        lines.append("")
        lines.append("  # Default deny for mount, umount, and pivot_root")
        lines.append("  deny mount,")
        lines.append("  deny umount,")
        lines.append("  deny pivot_root,")

        lines.append("}")

        return "\n".join(lines) + "\n"

    def write(self, path: Path) -> Path:
        """Write profile to a file. Returns the path written."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.generate())
        return path

    def to_docker_security_opt(self) -> str:
        """Return the Docker --security-opt value for this profile."""
        return f"apparmor={self.name}"


class AppArmorManager:
    """Manages per-agent-type AppArmor profiles for execution sandboxing.

    Builds profiles from the security.yaml permissions model, mapping
    agent capabilities to filesystem, capability, and network rules.
    """

    PROFILE_PREFIX = "paperclip-execution"

    def __init__(self, profile_dir: str = "/etc/paperclip/apparmor"):
        self.profile_dir = Path(profile_dir)
        self.profile_dir.mkdir(parents=True, exist_ok=True)

    def _profile_name(self, agent_type: str) -> str:
        return f"{self.PROFILE_PREFIX}-{agent_type}"

    def build_agent_profile(self, agent_type: str) -> AppArmorProfile:
        """Build an AppArmor profile for a specific agent type."""
        name = self._profile_name(agent_type)

        capabilities = AGENT_CAPABILITIES.get(agent_type, [AppArmorCapability.DAC_OVERRIDE])
        network_rules = AGENT_NETWORK_RULES.get(agent_type, [AppArmorNetwork.INET_TCP])

        filesystem_rules = list(COMMON_READONLY_PATHS)
        agent_fs_rules = AGENT_FILESYSTEM_RULES.get(agent_type, [])
        filesystem_rules.extend(agent_fs_rules)

        comment = f"Paperclip execution profile for agent type: {agent_type}"

        return AppArmorProfile(
            name=name,
            capabilities=capabilities,
            filesystem_rules=filesystem_rules,
            network_rules=network_rules,
            comment=comment,
        )

    def build_default_profile(self) -> AppArmorProfile:
        """Build the most restrictive profile used as fallback."""
        return AppArmorProfile(
            name=f"{self.PROFILE_PREFIX}-default",
            capabilities=[AppArmorCapability.DAC_OVERRIDE],
            filesystem_rules=list(COMMON_READONLY_PATHS) + [
                "/workspace/** r",
                "/tmp/** r",
            ],
            network_rules=[
                AppArmorNetwork.UNIX_STREAM,
                AppArmorNetwork.UNIX_DGRAM,
            ],
            comment="Default restrictive profile for unknown agent types",
        )

    def get_profile(self, agent_type: str) -> Optional[AppArmorProfile]:
        """Get a profile by agent type. Returns None for unknown types."""
        if agent_type in AGENT_CAPABILITIES:
            return self.build_agent_profile(agent_type)
        return None

    def write_profile(self, agent_type: str) -> Path:
        """Write a profile file to disk. Returns the path."""
        profile = self.build_agent_profile(agent_type)
        file_path = self.profile_dir / f"{profile.name}"
        return profile.write(file_path)

    def write_all_profiles(self) -> list[Path]:
        """Write all agent type profiles to disk."""
        paths: list[Path] = []
        paths.append(self.build_default_profile().write(
            self.profile_dir / f"{self.PROFILE_PREFIX}-default"
        ))
        for agent_type in AGENT_CAPABILITIES:
            paths.append(self.write_profile(agent_type))
        return paths

    def load_profile(self, agent_type: str) -> bool:
        """Load a profile into the kernel via apparmor_parser.

        Returns True if loading succeeded, False otherwise.
        """
        profile = self.build_agent_profile(agent_type)
        file_path = profile.write(self.profile_dir / f"{profile.name}")

        try:
            result = subprocess.run(
                ["apparmor_parser", "-r", "-W", str(file_path)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return result.returncode == 0
        except FileNotFoundError:
            return False
        except subprocess.TimeoutExpired:
            return False

    def unload_profile(self, agent_type: str) -> bool:
        """Unload a profile from the kernel."""
        name = self._profile_name(agent_type)
        try:
            result = subprocess.run(
                ["apparmor_parser", "-R", name],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return result.returncode == 0
        except FileNotFoundError:
            return False
        except subprocess.TimeoutExpired:
            return False

    def is_profile_loaded(self, agent_type: str) -> bool:
        """Check if a profile is loaded in the kernel."""
        name = self._profile_name(agent_type)
        profiles_path = Path("/sys/kernel/security/apparmor/profiles")
        if not profiles_path.exists():
            return False
        try:
            content = profiles_path.read_text()
            return name in content
        except (OSError, PermissionError):
            return False

    def get_docker_security_opts(self, agent_type: str) -> list[str]:
        """Build Docker security options including the AppArmor profile."""
        profile = self.get_profile(agent_type)
        if profile is None:
            profile = self.build_default_profile()
        return [profile.to_docker_security_opt()]

    def get_default_docker_security_opt(self) -> list[str]:
        """Build Docker security options with the default restrictive profile."""
        profile = self.build_default_profile()
        return [profile.to_docker_security_opt()]

    def get_all_profiles(self) -> dict[str, AppArmorProfile]:
        """Return all agent type profiles keyed by agent type name."""
        profiles: dict[str, AppArmorProfile] = {}
        profiles["default"] = self.build_default_profile()
        for agent_type in AGENT_CAPABILITIES:
            profiles[agent_type] = self.build_agent_profile(agent_type)
        return profiles
