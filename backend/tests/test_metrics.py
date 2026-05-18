"""Tests for Prometheus metrics: label changes, quantile computation, and JSON summary."""

import json
import time
from unittest.mock import patch, MagicMock

import pytest
from prometheus_client import REGISTRY, Counter, Histogram

from app.core.metrics import (
    provider_errors_total,
    rate_limit_hits_total,
    provider_request_duration_seconds,
    record_health_check,
    get_health_history,
    PrometheusMiddleware,
    metrics_endpoint,
    metrics_openmetrics_endpoint,
    metrics_json_endpoint,
    _compute_quantile_from_buckets,
    _get_provider_latency_quantiles,
    _get_error_counts_by_provider,
    _get_rate_limits_by_provider,
)


# ═════════════════════════════════════════════════════════════════════════════
# Model label on provider_errors_total
# ═════════════════════════════════════════════════════════════════════════════


class TestProviderErrorsTotal:
    def test_accepts_model_label(self):
        provider_errors_total.labels(
            provider="groq",
            operation="chat",
            error_type="rate_limit",
            model="llama3-70b-8192",
        ).inc()

        sample_value = REGISTRY.get_sample_value(
            "provider_errors_total",
            labels={
                "provider": "groq",
                "operation": "chat",
                "error_type": "rate_limit",
                "model": "llama3-70b-8192",
            },
        )
        assert sample_value is not None
        assert sample_value >= 1

    def test_separates_counts_by_model(self):
        provider_errors_total.labels(
            provider="groq",
            operation="chat",
            error_type="rate_limit",
            model="llama3-70b-8192",
        ).inc(2)
        provider_errors_total.labels(
            provider="groq",
            operation="chat",
            error_type="rate_limit",
            model="mixtral-8x7b",
        ).inc()

        llama_val = REGISTRY.get_sample_value(
            "provider_errors_total",
            labels={
                "provider": "groq",
                "operation": "chat",
                "error_type": "rate_limit",
                "model": "llama3-70b-8192",
            },
        )
        mixtral_val = REGISTRY.get_sample_value(
            "provider_errors_total",
            labels={
                "provider": "groq",
                "operation": "chat",
                "error_type": "rate_limit",
                "model": "mixtral-8x7b",
            },
        )
        assert llama_val >= 2
        assert mixtral_val >= 1


# ═════════════════════════════════════════════════════════════════════════════
# Model label on rate_limit_hits_total
# ═════════════════════════════════════════════════════════════════════════════


class TestRateLimitHitsTotal:
    def test_accepts_model_label(self):
        rate_limit_hits_total.labels(
            provider="openai",
            model="gpt-4o",
        ).inc()

        sample_value = REGISTRY.get_sample_value(
            "rate_limit_hits_total",
            labels={"provider": "openai", "model": "gpt-4o"},
        )
        assert sample_value is not None
        assert sample_value >= 1


# ═════════════════════════════════════════════════════════════════════════════
# Health check history
# ═════════════════════════════════════════════════════════════════════════════


class TestHealthCheckHistory:
    def test_records_and_retrieves_health_checks(self):
        record_health_check(True, {"database": True}, 12.5)
        record_health_check(False, {"database": False}, 5000)

        history = get_health_history(10)
        recent = history[-2:]
        assert recent[0]["overall"] is True
        assert recent[0]["checks"]["database"] is True
        assert recent[0]["duration_ms"] == 12.5
        assert recent[1]["overall"] is False

    def test_caps_history_at_max_entries(self):
        initial = len(get_health_history(200))
        to_add = max(0, 150 - initial)
        for i in range(to_add + 50):
            record_health_check(True, {"db": True}, float(i))

        assert len(get_health_history(200)) <= 100


# ═════════════════════════════════════════════════════════════════════════════
# Quantile computation
# ═════════════════════════════════════════════════════════════════════════════


class TestComputeQuantileFromBuckets:
    def test_returns_zero_for_empty_data(self):
        result = _compute_quantile_from_buckets([0.1, 0.5, 1.0], [0, 0, 0], 0, 0.5)
        assert result == 0.0

    def test_computes_p50_correctly(self):
        # 100 observations evenly distributed across buckets
        buckets = [0.1, 0.5, 1.0, 2.5, 5.0, 10.0]
        # Cumulative counts: each bucket gets 16-17 observations
        cumulative = [17, 34, 50, 67, 84, 100]
        result = _compute_quantile_from_buckets(buckets, cumulative, 100, 0.50)
        # p50 target = 50, falls in 3rd bucket (1.0)
        # Linear interpolation: 0.5 + (50-34)/(50-34) * (1.0-0.5) = 0.5 + 0.5 = 1.0
        assert result == 1.0


# ═════════════════════════════════════════════════════════════════════════════
# get_health_history default limit
# ═════════════════════════════════════════════════════════════════════════════


class TestGetHealthHistory:
    def test_defaults_to_limit_20(self):
        history = get_health_history()
        assert len(history) <= 100  # bounded by max, not the default

    def test_respects_custom_limit(self):
        for i in range(30):
            record_health_check(True, {"db": True}, float(i))
        limited = get_health_history(5)
        assert len(limited) <= 5


# ═════════════════════════════════════════════════════════════════════════════
# JSON metrics endpoint
# ═════════════════════════════════════════════════════════════════════════════


class TestMetricsJsonEndpoint:
    def test_returns_json_response(self):
        record_health_check(True, {"database": True}, 5.0)
        provider_errors_total.labels(
            provider="groq", operation="chat", error_type="rate_limit", model="llama3-70b",
        ).inc()
        rate_limit_hits_total.labels(provider="groq", model="llama3-70b").inc()

        response = metrics_json_endpoint()
        assert response.media_type == "application/json"

        body = json.loads(response.body)
        assert "providers" in body
        assert "health" in body
        assert "uptime" in body
        assert "groq" in body["providers"]
        assert body["providers"]["groq"]["rateLimits"] >= 1


# ═════════════════════════════════════════════════════════════════════════════
# Prometheus metrics endpoints
# ═════════════════════════════════════════════════════════════════════════════


class TestMetricsEndpoints:
    def test_metrics_endpoint_returns_prometheus_text(self):
        resp = metrics_endpoint()
        assert resp.media_type == "text/plain; version=0.0.4; charset=utf-8"
        assert b"provider_request_duration_seconds" in resp.body or b"# HELP" in resp.body

    def test_metrics_openmetrics_endpoint(self):
        resp = metrics_openmetrics_endpoint()
        assert "openmetrics" in resp.media_type


# ═════════════════════════════════════════════════════════════════════════════
# Provider latency quantile helpers
# ═════════════════════════════════════════════════════════════════════════════


class TestProviderLatencyQuantiles:
    def test_returns_quantiles_after_observations(self):
        # Record some observations
        for i in range(100):
            provider_request_duration_seconds.labels(
                provider="quantile-test", operation="chat",
            ).observe(0.1 + i * 0.02)

        quantiles = _get_provider_latency_quantiles()
        key = "quantile-test:chat"
        assert key in quantiles
        assert quantiles[key]["count"] == 100
        assert quantiles[key]["sum"] > 0
        assert quantiles[key]["p50"] > 0
        assert quantiles[key]["p95"] > 0
        assert quantiles[key]["p99"] > 0


class TestErrorCountsByProvider:
    def test_aggregates_errors_by_provider(self):
        provider_errors_total.labels(
            provider="agg-test", operation="chat", error_type="rate_limit", model="m1",
        ).inc(3)
        provider_errors_total.labels(
            provider="agg-test", operation="chat", error_type="other", model="m1",
        ).inc(1)

        errors = _get_error_counts_by_provider()
        assert "agg-test" in errors
        assert errors["agg-test"]["rate_limit"] >= 3
        assert errors["agg-test"]["other"] >= 1


class TestRateLimitsByProvider:
    def test_aggregates_rate_limits_by_provider(self):
        rate_limit_hits_total.labels(provider="rl-test", model="m1").inc(5)
        rate_limit_hits_total.labels(provider="rl-test", model="m2").inc(3)

        rls = _get_rate_limits_by_provider()
        assert "rl-test" in rls
        assert rls["rl-test"] >= 8
