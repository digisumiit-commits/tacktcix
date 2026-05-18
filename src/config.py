"""Load and validate execution worker configuration from YAML files."""

import os
import socket
import yaml
from dataclasses import dataclass, field
from typing import Optional


class ConfigError(Exception):
    pass


@dataclass
class ResourceProfile:
    cpu_shares: int
    cpu_quota: int
    cpu_period: int
    memory_mb: int
    memory_swap_mb: int
    disk_size_gb: int
    pids_limit: int
    description: str


@dataclass
class WorkerConfig:
    id: str
    group: str
    max_concurrent_jobs: int
    shutdown_timeout: int


@dataclass
class RedisConfig:
    host: str
    port: int
    db: int
    password: str
    stream: str
    claim_timeout_ms: int
    block_ms: int


@dataclass
class DockerConfig:
    host: str
    default_image: str
    network: str
    pull_policy: str


@dataclass
class SandboxConfig:
    default_profile: str
    default_timeout_s: int
    max_timeout_s: int
    workspace_mount: str
    read_only_rootfs: bool
    default_network_access: bool
    tmpfs_size_mb: int
    drop_all_capabilities: bool
    profiles: dict[str, ResourceProfile] = field(default_factory=dict)
    apparmor_profile_dir: str = "/etc/paperclip/apparmor"
    apparmor_enabled: bool = True


@dataclass
class HealthConfig:
    port: int
    path: str
    check_interval_s: int
    max_failures: int
    auto_restart: bool


@dataclass
class MonitoringConfig:
    log_level: str
    json_logs: bool
    metrics_interval_s: int


@dataclass
class NetworkEgressConfig:
    default_policy: str
    egress_rules: dict[str, list[str]]
    dns_servers: list[str]
    dns_search_domains: list[str]


@dataclass
class AppConfig:
    worker: WorkerConfig
    redis: RedisConfig
    docker: DockerConfig
    sandbox: SandboxConfig
    health: HealthConfig
    monitoring: MonitoringConfig
    network_egress: NetworkEgressConfig


def _resolve_env(value: str) -> str:
    """Resolve ${ENV_VAR:-default} patterns in a string."""
    import re

    def replacer(match):
        expr = match.group(1)
        if ":-" in expr:
            var, default = expr.split(":-", 1)
            return os.environ.get(var.strip(), default.strip())
        return os.environ.get(expr.strip(), "")

    return re.sub(r"\$\{([^}]+)\}", replacer, value)


def _resolve_dict(d: dict) -> dict:
    """Recursively resolve env vars in dict values."""
    result = {}
    for k, v in d.items():
        if isinstance(v, str):
            result[k] = _resolve_env(v)
        elif isinstance(v, dict):
            result[k] = _resolve_dict(v)
        elif isinstance(v, list):
            result[k] = [
                _resolve_env(item) if isinstance(item, str) else item for item in v
            ]
        else:
            result[k] = v
    return result


def _load_yaml(path: str) -> dict:
    with open(path, "r") as f:
        return yaml.safe_load(f)


def load_security_network(path: str = "config/security.yaml") -> NetworkEgressConfig:
    """Load network egress rules from security.yaml."""
    raw = _load_yaml(path)
    resolved = _resolve_dict(raw)
    net = resolved.get("network", {})
    return NetworkEgressConfig(
        default_policy=net.get("default_policy", "deny"),
        egress_rules=net.get("egress_rules", {}),
        dns_servers=net.get("dns_servers", []),
        dns_search_domains=net.get("dns_search_domains", []),
    )


def load_profiles(path: str) -> dict[str, ResourceProfile]:
    raw = _load_yaml(path)
    resolved = _resolve_dict(raw)
    profiles = {}
    for name, data in resolved.get("profiles", {}).items():
        profiles[name] = ResourceProfile(
            cpu_shares=int(data["cpu_shares"]),
            cpu_quota=int(data["cpu_quota"]),
            cpu_period=int(data["cpu_period"]),
            memory_mb=int(data["memory_mb"]),
            memory_swap_mb=int(data["memory_swap_mb"]),
            disk_size_gb=int(data["disk_size_gb"]),
            pids_limit=int(data["pids_limit"]),
            description=data["description"],
        )
    if not profiles:
        raise ConfigError("No resource profiles defined")
    return profiles


_app_config: Optional[AppConfig] = None


def load_config(
    config_dir: str = "config",
    worker_path: Optional[str] = None,
    profiles_path: Optional[str] = None,
) -> AppConfig:
    global _app_config
    if _app_config is not None:
        return _app_config

    if worker_path is None:
        worker_path = os.path.join(config_dir, "worker.yaml")
    if profiles_path is None:
        profiles_path = os.path.join(config_dir, "resource_profiles.yaml")

    raw = _load_yaml(worker_path)
    resolved = _resolve_dict(raw)

    w = resolved["worker"]
    r = resolved["redis"]
    d = resolved["docker"]
    s = resolved["sandbox"]
    h = resolved["health"]
    m = resolved["monitoring"]

    worker = WorkerConfig(
        id=_resolve_env(w.get("id", f"worker-{socket.gethostname()}")),
        group=w["group"],
        max_concurrent_jobs=int(w["max_concurrent_jobs"]),
        shutdown_timeout=int(w["shutdown_timeout"]),
    )

    redis = RedisConfig(
        host=r["host"],
        port=int(r["port"]),
        db=int(r["db"]),
        password=r.get("password", ""),
        stream=r["stream"],
        claim_timeout_ms=int(r["claim_timeout_ms"]),
        block_ms=int(r["block_ms"]),
    )

    docker = DockerConfig(
        host=d["host"],
        default_image=d["default_image"],
        network=d["network"],
        pull_policy=d["pull_policy"],
    )

    sandbox = SandboxConfig(
        default_profile=s["default_profile"],
        default_timeout_s=int(s["default_timeout_s"]),
        max_timeout_s=int(s["max_timeout_s"]),
        workspace_mount=s["workspace_mount"],
        read_only_rootfs=bool(s["read_only_rootfs"]),
        default_network_access=bool(s["default_network_access"]),
        tmpfs_size_mb=int(s["tmpfs_size_mb"]),
        drop_all_capabilities=bool(s["drop_all_capabilities"]),
        profiles=load_profiles(profiles_path),
        apparmor_profile_dir=s.get("apparmor_profile_dir", "/etc/paperclip/apparmor"),
        apparmor_enabled=bool(s.get("apparmor_enabled", True)),
    )

    health = HealthConfig(
        port=int(h["port"]),
        path=h["path"],
        check_interval_s=int(h["check_interval_s"]),
        max_failures=int(h["max_failures"]),
        auto_restart=bool(h["auto_restart"]),
    )

    monitoring = MonitoringConfig(
        log_level=m["log_level"],
        json_logs=bool(m["json_logs"]),
        metrics_interval_s=int(m["metrics_interval_s"]),
    )

    security_net_path = os.path.join(config_dir, "security.yaml")
    network_egress = load_security_network(security_net_path)

    _app_config = AppConfig(
        worker=worker,
        redis=redis,
        docker=docker,
        sandbox=sandbox,
        health=health,
        monitoring=monitoring,
        network_egress=network_egress,
    )
    return _app_config


def get_config() -> AppConfig:
    """Return the cached config, loading it if not already loaded."""
    global _app_config
    if _app_config is None:
        return load_config()
    return _app_config
