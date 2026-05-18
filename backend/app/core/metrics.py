"""Prometheus metrics definitions and ASGI middleware for the TACKTCIX backend."""

import json
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

from fastapi import Request, Response
from prometheus_client import Counter, Histogram, Gauge, generate_latest, REGISTRY
from prometheus_client.openmetrics import exposition as openmetrics
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

# ── Request Metrics ─────────────────────────────────────────────────────────

http_requests_total = Counter(
    "http_requests_total",
    "Total HTTP requests",
    labelnames=["method", "endpoint", "status"],
)

http_request_duration_seconds = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    labelnames=["method", "endpoint"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

http_requests_in_flight = Gauge(
    "http_requests_in_flight",
    "Current number of in-flight HTTP requests",
    labelnames=["method"],
)

# ── Health Check Metrics ────────────────────────────────────────────────────

health_check_status = Gauge(
    "health_check_status",
    "Current health check status (1 = healthy, 0 = unhealthy)",
)

# ── Provider / External Dependency Metrics ──────────────────────────────────

provider_request_duration_seconds = Histogram(
    "provider_request_duration_seconds",
    "Latency of external provider (AI model / DB) requests",
    labelnames=["provider", "operation"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
)

provider_errors_total = Counter(
    "provider_errors_total",
    "Total errors from external providers",
    labelnames=["provider", "operation", "error_type", "model"],
)

rate_limit_hits_total = Counter(
    "rate_limit_hits_total",
    "Total rate limit hits",
    labelnames=["provider", "model"],
)

# ── Health Check History (in-memory ring buffer) ────────────────────────────

_health_history: deque[dict] = deque(maxlen=100)


def record_health_check(
    overall: bool,
    checks: dict[str, bool],
    duration_ms: float,
) -> None:
    """Record a health check result into the in-memory history."""
    _health_history.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "overall": overall,
        "checks": checks,
        "duration_ms": round(duration_ms, 1),
    })
    health_check_status.set(1 if overall else 0)


def get_health_history(limit: int = 20) -> list[dict]:
    """Return the most recent health check records."""
    return list(_health_history)[-limit:]


# ── Middleware ──────────────────────────────────────────────────────────────

METRICS_SKIP_PATHS = {"/metrics", "/metrics/openmetrics", "/metrics/api", "/favicon.ico"}


class PrometheusMiddleware(BaseHTTPMiddleware):
    """Records HTTP request count, duration, and concurrency."""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path

        if path in METRICS_SKIP_PATHS:
            return await call_next(request)

        method = request.method
        http_requests_in_flight.labels(method=method).inc()

        start = time.monotonic()
        try:
            response = await call_next(request)
            return response
        finally:
            elapsed = time.monotonic() - start
            http_requests_in_flight.labels(method=method).dec()

            # Determine endpoint label — collapse UUID path segments
            endpoint = _normalize_path(path)
            status = getattr(response, "status_code", 500)

            http_requests_total.labels(method=method, endpoint=endpoint, status=status).inc()
            http_request_duration_seconds.labels(method=method, endpoint=endpoint).observe(elapsed)


def _normalize_path(path: str) -> str:
    """Collapse UUID and numeric segments into a pattern placeholder."""
    import re
    segments = path.strip("/").split("/")
    normalized = []
    for seg in segments:
        if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", seg):
            normalized.append("{uuid}")
        elif seg.isdigit():
            normalized.append("{id}")
        else:
            normalized.append(seg)
    return "/" + "/".join(normalized)


def metrics_endpoint():
    """Standard Prometheus text-format metrics."""
    return Response(
        content=generate_latest(REGISTRY),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


def metrics_openmetrics_endpoint():
    """OpenMetrics exposition format."""
    return Response(
        content=openmetrics.generate_latest(REGISTRY),
        media_type="application/openmetrics-text; version=1.0.0; charset=utf-8",
    )


# ── JSON Metrics Summary ──────────────────────────────────────────────────


def _compute_quantile_from_buckets(
    buckets: list[float],
    cumulative_counts: list[int],
    total_count: int,
    quantile: float,
) -> float:
    """Compute approximate quantile from cumulative histogram bucket counts."""
    if total_count == 0:
        return 0.0

    target = total_count * quantile
    rank = 0
    for i, cc in enumerate(cumulative_counts):
        if cc >= target:
            rank = i
            break
    else:
        return buckets[-1] if buckets else 0.0

    if rank == 0:
        return buckets[0] * (target / max(cumulative_counts[0], 1))

    lower_count = cumulative_counts[rank - 1]
    upper_count = cumulative_counts[rank]
    bucket_width = buckets[rank] - buckets[rank - 1]
    fraction = (target - lower_count) / max(upper_count - lower_count, 1)
    return round(buckets[rank - 1] + fraction * bucket_width, 4)


def _get_provider_latency_quantiles() -> dict[str, dict[str, float | int]]:
    """Extract p50/p95/p99 from the provider latency histogram."""
    result: dict[str, dict[str, float | int]] = {}

    for metric_family in REGISTRY.collect():
        if metric_family.name != "provider_request_duration_seconds":
            continue

        # Group samples by (provider, operation) label set
        buckets_by_labels: dict[tuple, dict[float, int]] = {}
        sums: dict[tuple, float] = {}
        counts: dict[tuple, int] = {}

        for sample in metric_family.samples:
            labels = sample.labels
            provider = labels.get("provider", "")
            operation = labels.get("operation", "")
            key = (provider, operation)

            if "le" in labels:
                le_val = float(labels["le"])
                if key not in buckets_by_labels:
                    buckets_by_labels[key] = {}
                buckets_by_labels[key][le_val] = int(sample.value)
            elif sample.name.endswith("_sum"):
                sums[key] = sample.value
            elif sample.name.endswith("_count"):
                counts[key] = int(sample.value)

        upper_bounds = [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0]

        for key, buckets in buckets_by_labels.items():
            # Build cumulative counts from per-bucket counts
            cumulative = []
            running = 0
            for ub in upper_bounds:
                running += buckets.get(ub, 0)
                cumulative.append(running)

            total_count = cumulative[-1] if cumulative else 0
            label_key = f"{key[0]}:{key[1]}"

            p50 = _compute_quantile_from_buckets(upper_bounds, cumulative, total_count, 0.50)
            p95 = _compute_quantile_from_buckets(upper_bounds, cumulative, total_count, 0.95)
            p99 = _compute_quantile_from_buckets(upper_bounds, cumulative, total_count, 0.99)

            result[label_key] = {
                "p50": p50,
                "p95": p95,
                "p99": p99,
                "count": counts.get(key, 0),
                "sum": round(sums.get(key, 0), 4),
            }

    return result


def _get_error_counts_by_provider() -> dict[str, dict[str, float]]:
    """Aggregate error counts by provider and error_type."""
    result: dict[str, dict[str, float]] = {}
    for metric_family in REGISTRY.collect():
        if metric_family.name != "provider_errors_total":
            continue
        for sample in metric_family.samples:
            provider = sample.labels.get("provider", "")
            err_type = sample.labels.get("error_type", "unknown")
            if provider not in result:
                result[provider] = {}
            result[provider][err_type] = result[provider].get(err_type, 0) + sample.value
    return result


def _get_rate_limits_by_provider() -> dict[str, float]:
    """Aggregate rate limit hits by provider."""
    result: dict[str, float] = {}
    for metric_family in REGISTRY.collect():
        if metric_family.name != "rate_limit_hits_total":
            continue
        for sample in metric_family.samples:
            provider = sample.labels.get("provider", "")
            result[provider] = result.get(provider, 0) + sample.value
    return result


def metrics_json_endpoint():
    """Return a JSON summary of all health metrics."""
    latency = _get_provider_latency_quantiles()
    errors = _get_error_counts_by_provider()
    rate_limits = _get_rate_limits_by_provider()
    history = get_health_history(20)

    all_providers: set[str] = set()
    for k in latency:
        all_providers.add(k.split(":")[0])
    all_providers.update(errors.keys())
    all_providers.update(rate_limits.keys())

    default_latency = {"p50": 0, "p95": 0, "p99": 0, "count": 0, "sum": 0}
    providers_dict: dict[str, dict[str, Any]] = {}

    for pk in sorted(all_providers):
        latency_key = next((k for k in latency if k.startswith(f"{pk}:")), None)
        providers_dict[pk] = {
            "latency": latency.get(latency_key, default_latency) if latency_key else default_latency,
            "errors": errors.get(pk, {}),
            "rateLimits": rate_limits.get(pk, 0),
        }

    current_status = 1
    if history:
        current_status = 1 if history[-1]["overall"] else 0

    body = {
        "providers": providers_dict,
        "health": {
            "current": current_status,
            "history": history,
        },
        "uptime": time.time(),
    }

    return Response(
        content=json.dumps(body),
        media_type="application/json",
    )
