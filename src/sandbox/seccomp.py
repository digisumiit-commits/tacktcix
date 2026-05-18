"""Seccomp profile management for execution sandboxing.

Generates and validates seccomp BPF profiles that restrict system calls
to a safe allowlist. Three tiers: default (~50 safe syscalls), restrictive (~30),
and permissive (dev only, ~100).
"""

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

# Architecture constants
ARCH = "SCMP_ARCH_X86_64"


class SeccompAction(str, Enum):
    ALLOW = "SCMP_ACT_ALLOW"
    KILL = "SCMP_ACT_KILL"
    ERRNO = "SCMP_ACT_ERRNO"
    TRAP = "SCMP_ACT_TRAP"
    LOG = "SCMP_ACT_LOG"


# Syscalls considered safe for most execution workloads
DEFAULT_ALLOWED_SYSCALLS: list[str] = sorted([
    # Process management
    "read", "write", "close", "lseek", "pread64", "pwrite64",
    "readv", "writev", "dup", "dup2", "dup3",
    "fcntl", "ioctl",
    # Memory
    "mmap", "mprotect", "munmap", "brk", "mremap",
    "madvise", "mseal",
    # Process lifecycle
    "clone", "clone3", "fork", "vfork", "execve", "execveat",
    "exit", "exit_group", "wait4", "waitid",
    "getpid", "getppid", "gettid", "getuid", "geteuid", "getgid", "getegid",
    # Signals
    "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
    "sigaltstack", "kill", "tgkill",
    # Filesystem
    "stat", "lstat", "fstat", "newfstatat",
    "openat", "openat2", "getdents64",
    "mkdir", "mkdirat", "rmdir", "unlink", "unlinkat",
    "rename", "renameat", "renameat2",
    "link", "linkat", "symlink", "symlinkat",
    "readlink", "readlinkat",
    "chdir", "fchdir", "getcwd",
    "chmod", "fchmod", "fchmodat",
    "chown", "fchown", "fchownat",
    "access", "faccessat", "faccessat2",
    # Time
    "clock_gettime", "clock_nanosleep", "nanosleep",
    "gettimeofday", "time",
    # Scheduling
    "sched_yield", "sched_getaffinity", "sched_setaffinity",
    # Futex
    "futex", "futex_waitv", "futex_wake",
    # Network (safe subset)
    "socket", "connect", "bind", "listen", "accept", "accept4",
    "sendto", "recvfrom", "sendmsg", "recvmsg",
    "getsockname", "getpeername", "getsockopt", "setsockopt",
    "shutdown",
    # Polling
    "poll", "ppoll", "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait",
    # Misc safe
    "getrandom", "getdents",
    "arch_prctl", "set_tid_address", "set_robust_list",
    "prlimit64", "rseq",
    "uname", "getrusage", "getrlimit",
    "prctl", "seccomp",
])

# Additional syscalls removed in restrictive mode
RESTRICTIVE_REMOVED: set[str] = {
    "clone", "clone3", "fork", "vfork", "execve", "execveat",
    "ptrace", "process_vm_readv", "process_vm_writev",
    "socket", "connect", "bind", "listen", "accept", "accept4",
    "sendto", "recvfrom", "sendmsg", "recvmsg",
    "shutdown", "socketpair",
    "kill", "tgkill", "tkill",
}

# Extra syscalls for development
PERMISSIVE_EXTRAS: set[str] = {
    "ptrace",
    "process_vm_readv", "process_vm_writev",
    "socketpair",
    "pipe", "pipe2",
    "eventfd", "eventfd2",
    "memfd_create", "memfd_secret",
    "userfaultfd",
    "bpf",
    "perf_event_open",
}

# Always blocked syscalls (common attack vectors)
ALWAYS_BLOCKED: list[str] = [
    "reboot",
    "kexec_load", "kexec_file_load",
    "init_module", "finit_module", "delete_module",
    "create_module",
    "ioperm", "iopl",
    "ioprio_set", "ioprio_get",
    "kcmp",
    "move_pages", "mbind", "migrate_pages",
    "add_key", "request_key", "keyctl",
    "lookup_dcookie",
    "nfsservctl",
    "_sysctl",
    "acct",
    "modify_ldt",
    "pivot_root",
    "setns",
    "unshare",
    "mount", "umount2",
    "swapon", "swapoff",
    "personality",
    "syslog",
    "setuid", "setgid", "setreuid", "setregid",
    "setresuid", "setresgid", "setfsuid", "setfsgid",
    "capset", "capget",
    "chroot",
]


@dataclass
class SeccompProfile:
    name: str
    default_action: SeccompAction = SeccompAction.KILL
    allowed_syscalls: list[str] = field(default_factory=list)
    blocked_syscalls: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "defaultAction": self.default_action.value,
            "architectures": [ARCH],
            "syscalls": [
                {"names": self.allowed_syscalls, "action": SeccompAction.ALLOW.value},
                {"names": self.blocked_syscalls, "action": SeccompAction.KILL.value},
            ],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    def to_docker_config(self) -> dict:
        """Return Docker-compatible seccomp security options."""
        return {
            "SecurityOpt": [f"seccomp={json.dumps(self.to_dict())}"],
        }


class SeccompManager:
    """Manages seccomp profiles for execution sandboxing."""

    def __init__(self, profile_dir: str = "/etc/paperclip/seccomp"):
        self.profile_dir = Path(profile_dir)
        self.profile_dir.mkdir(parents=True, exist_ok=True)

    def build_default_profile(self) -> SeccompProfile:
        return SeccompProfile(
            name="default",
            default_action=SeccompAction.KILL,
            allowed_syscalls=DEFAULT_ALLOWED_SYSCALLS,
            blocked_syscalls=ALWAYS_BLOCKED,
        )

    def build_restrictive_profile(self) -> SeccompProfile:
        allowed = [s for s in DEFAULT_ALLOWED_SYSCALLS if s not in RESTRICTIVE_REMOVED]
        return SeccompProfile(
            name="restrictive",
            default_action=SeccompAction.KILL,
            allowed_syscalls=allowed,
            blocked_syscalls=ALWAYS_BLOCKED,
        )

    def build_permissive_profile(self) -> SeccompProfile:
        allowed = sorted(set(DEFAULT_ALLOWED_SYSCALLS) | PERMISSIVE_EXTRAS)
        return SeccompProfile(
            name="permissive",
            default_action=SeccompAction.KILL,
            allowed_syscalls=allowed,
            blocked_syscalls=ALWAYS_BLOCKED,
        )

    def get_profile(self, name: str) -> Optional[SeccompProfile]:
        file_path = self.profile_dir / f"{name}.json"
        if file_path.exists():
            return self.load_profile(file_path)
        if name == "default":
            return self.build_default_profile()
        if name == "restrictive":
            return self.build_restrictive_profile()
        if name == "permissive":
            return self.build_permissive_profile()
        return None

    def save_profile(self, profile: SeccompProfile) -> Path:
        file_path = self.profile_dir / f"{profile.name}.json"
        with open(file_path, "w") as f:
            f.write(profile.to_json())
        return file_path

    def load_profile(self, file_path: str) -> SeccompProfile:
        with open(file_path) as f:
            data = json.load(f)

        allowed = []
        blocked = []
        for entry in data.get("syscalls", []):
            action = entry.get("action", "")
            if action == SeccompAction.ALLOW.value:
                allowed.extend(entry.get("names", []))
            elif action in (SeccompAction.KILL.value, SeccompAction.ERRNO.value):
                blocked.extend(entry.get("names", []))

        default_action = SeccompAction(data.get("defaultAction", SeccompAction.KILL.value))

        return SeccompProfile(
            name=file_path.stem if isinstance(file_path, Path) else Path(file_path).stem,
            default_action=default_action,
            allowed_syscalls=sorted(allowed),
            blocked_syscalls=sorted(blocked),
        )

    def validate_syscall(self, profile: SeccompProfile, syscall_name: str) -> bool:
        """Check if a syscall is allowed by the profile."""
        if syscall_name in profile.blocked_syscalls:
            return False
        if profile.default_action == SeccompAction.KILL:
            return syscall_name in profile.allowed_syscalls
        return syscall_name not in profile.blocked_syscalls

    def get_docker_security_opts(self, profile_name: str) -> list[str]:
        """Build Docker security options for a seccomp profile."""
        profile = self.get_profile(profile_name)
        if profile is None:
            raise ValueError(f"Unknown seccomp profile: {profile_name}")

        profile_json = json.dumps(profile.to_dict())
        return [
            f"seccomp={profile_json}",
            "no-new-privileges=true",
        ]
