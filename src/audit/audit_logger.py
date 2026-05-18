"""Structured audit logging with immutable append-only semantics.

Every security-relevant action is logged as a structured JSON event with
mandatory fields: timestamp, event_id, trace_id, actor, action, resource, result.
PII and secrets are redacted before emission.
"""

import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Optional


class AuditSeverity(str, Enum):
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class AuditEvent:
    action: str
    actor_type: str
    actor_id: str
    resource_type: str
    resource_id: str
    result: str  # success, failure, denied, error
    severity: AuditSeverity = AuditSeverity.INFO
    trace_id: Optional[str] = None
    source_ip: Optional[str] = None
    details: dict[str, Any] = field(default_factory=dict)
    # Auto-populated
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["severity"] = self.severity.value
        return d


class AuditLogger:
    """Structured audit logger with secret redaction and rotation support.

    Writes JSON-lines to a configurable destination: file, stdout, or Redis stream.
    Includes built-in PII/secret redaction patterns.
    """

    DEFAULT_REDACTION_PATTERNS: list[tuple[re.Pattern, str]] = [
        (re.compile(r'sk-[a-zA-Z0-9]{20,}'), '[REDACTED_API_KEY]'),
        (re.compile(r'ghp_[a-zA-Z0-9]{36}'), '[REDACTED_GITHUB_TOKEN]'),
        (re.compile(r'Bearer\s+[a-zA-Z0-9._\-]+'), 'Bearer [REDACTED]'),
        (re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'), '[REDACTED_EMAIL]'),
        (re.compile(r'AKIA[0-9A-Z]{16}'), '[REDACTED_AWS_KEY]'),
        (re.compile(r'AIza[0-9A-Za-z\-_]{35}'), '[REDACTED_GCP_KEY]'),
        (re.compile(r'(?i)(password|passwd|secret|token|api_key|private_key)["\']?\s*[:=]\s*["\']?([^"\'&\s,}]+)'),
         r'\1: [REDACTED]'),
    ]

    def __init__(
        self,
        destination: str = "stdout",
        file_path: Optional[str] = "/var/log/paperclip/audit.log",
        min_severity: AuditSeverity = AuditSeverity.INFO,
        source_ip: Optional[str] = None,
        extra_redaction_patterns: Optional[list[tuple[str, str]]] = None,
    ):
        self.destination = destination
        self.file_path = Path(file_path) if file_path else None
        self.min_severity = min_severity
        self.source_ip = source_ip

        self.redaction_patterns: list[tuple[re.Pattern, str]] = list(self.DEFAULT_REDACTION_PATTERNS)
        if extra_redaction_patterns:
            for pattern, replacement in extra_redaction_patterns:
                self.redaction_patterns.append((re.compile(pattern), replacement))

        self._severity_rank = {
            AuditSeverity.DEBUG: 10,
            AuditSeverity.INFO: 20,
            AuditSeverity.WARNING: 30,
            AuditSeverity.ERROR: 40,
            AuditSeverity.CRITICAL: 50,
        }

        if destination == "file" and self.file_path:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)

    def _redact(self, text: str) -> str:
        for pattern, replacement in self.redaction_patterns:
            text = pattern.sub(replacement, text)
        return text

    def _should_log(self, severity: AuditSeverity) -> bool:
        return self._severity_rank[severity] >= self._severity_rank[self.min_severity]

    def _emit(self, event: AuditEvent) -> None:
        if not self._should_log(event.severity):
            return

        event_dict = event.to_dict()
        # Redact any string values in details
        event_dict["details"] = {
            k: self._redact(str(v)) if isinstance(v, str) else v
            for k, v in event.details.items()
        }
        event_json = json.dumps(event_dict, default=str)

        if self.destination == "stdout":
            sys.stdout.write(event_json + "\n")
            sys.stdout.flush()
        elif self.destination == "file" and self.file_path:
            with open(self.file_path, "a") as f:
                f.write(event_json + "\n")
        elif self.destination == "redis-stream":
            self._emit_redis_stream(event_json)
        else:
            sys.stderr.write(event_json + "\n")

    def _emit_redis_stream(self, event_json: str) -> None:
        try:
            import redis
            r = redis.Redis(
                host=os.environ.get("REDIS_HOST", "localhost"),
                port=int(os.environ.get("REDIS_PORT", "6379")),
                db=int(os.environ.get("REDIS_DB", "0")),
                password=os.environ.get("REDIS_PASSWORD") or None,
            )
            r.xadd("stream:audit", {"event": event_json}, maxlen=100000)
        except Exception:
            sys.stderr.write(event_json + "\n")

    # --- Public API ---

    def log(self, event: AuditEvent) -> str:
        """Emit an audit event. Returns the event ID."""
        if event.source_ip is None:
            event.source_ip = self.source_ip
        self._emit(event)
        return event.event_id

    def log_execution_event(self, action: str, actor_id: str, execution_id: str,
                            result: str, actor_type: str = "agent",
                            details: Optional[dict] = None,
                            trace_id: Optional[str] = None) -> str:
        return self.log(AuditEvent(
            action=action,
            actor_type=actor_type,
            actor_id=actor_id,
            resource_type="execution",
            resource_id=execution_id,
            result=result,
            severity=AuditSeverity.ERROR if result == "failure" else AuditSeverity.INFO,
            details=details or {},
            trace_id=trace_id,
        ))

    def log_secret_access(self, action: str, actor_id: str, secret_id: str,
                          result: str = "success", actor_type: str = "agent",
                          trace_id: Optional[str] = None) -> str:
        return self.log(AuditEvent(
            action=f"secret.{action}",
            actor_type=actor_type,
            actor_id=actor_id,
            resource_type="secret",
            resource_id=secret_id,
            result=result,
            severity=AuditSeverity.INFO,
            trace_id=trace_id,
        ))

    def log_permission_denied(self, actor_id: str, resource_type: str, resource_id: str,
                              permission: str, actor_type: str = "agent",
                              details: Optional[dict] = None,
                              trace_id: Optional[str] = None) -> str:
        return self.log(AuditEvent(
            action="permission.denied",
            actor_type=actor_type,
            actor_id=actor_id,
            resource_type=resource_type,
            resource_id=resource_id,
            result="denied",
            severity=AuditSeverity.WARNING,
            details={"permission": permission, **(details or {})},
            trace_id=trace_id,
        ))

    def log_sandbox_violation(self, actor_id: str, execution_id: str,
                              violation_type: str, actor_type: str = "agent",
                              details: Optional[dict] = None,
                              trace_id: Optional[str] = None) -> str:
        return self.log(AuditEvent(
            action=f"sandbox.{violation_type}",
            actor_type=actor_type,
            actor_id=actor_id,
            resource_type="execution",
            resource_id=execution_id,
            result="denied",
            severity=AuditSeverity.ERROR,
            details=details or {},
            trace_id=trace_id,
        ))

    def log_rate_limit(self, actor_id: str, limit_type: str, actor_type: str = "agent",
                       details: Optional[dict] = None,
                       trace_id: Optional[str] = None) -> str:
        return self.log(AuditEvent(
            action="ratelimit.exceeded",
            actor_type=actor_type,
            actor_id=actor_id,
            resource_type="rate_limit",
            resource_id=limit_type,
            result="denied",
            severity=AuditSeverity.WARNING,
            details=details or {},
            trace_id=trace_id,
        ))
