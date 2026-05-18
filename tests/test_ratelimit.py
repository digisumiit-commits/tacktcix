"""Tests for rate limiting token bucket."""

import time

from src.ratelimit import TokenBucket, RateLimiter, RateLimitExceeded


class TestTokenBucket:
    def test_initial_tokens_equal_burst(self):
        bucket = TokenBucket(rate=10, burst=20)
        assert bucket.tokens == 20.0

    def test_consume_reduces_tokens(self):
        bucket = TokenBucket(rate=100, burst=100)
        assert bucket.consume(5)
        assert bucket.tokens < 100

    def test_empty_bucket_rejects(self):
        bucket = TokenBucket(rate=0.1, burst=0)  # Very slow refill
        bucket.tokens = 0
        assert not bucket.consume(1)

    def test_refill_over_time(self):
        bucket = TokenBucket(rate=100, burst=10)
        bucket.tokens = 0
        bucket.last_refill = time.monotonic() - 0.1
        assert bucket.consume(5)

    def test_tokens_cannot_exceed_burst(self):
        bucket = TokenBucket(rate=1000, burst=5)
        bucket.tokens = 0
        bucket.last_refill = time.monotonic() - 10  # Would refill 10000 tokens
        bucket.consume(0)  # Just refill
        assert bucket.tokens <= 5.0

    def test_retry_after_positive(self):
        bucket = TokenBucket(rate=10, burst=0)
        bucket.tokens = 0
        retry = bucket.retry_after()
        assert retry >= 0


class TestRateLimiter:
    def setup_method(self):
        self.limiter = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=100, per_agent_burst=100,
            per_execution_rate=50, per_execution_burst=50,
        )

    def test_allows_within_limit(self):
        self.limiter.check("agent-1", "exec-1")

    def test_global_burst_respected(self):
        limiter = RateLimiter(
            global_rate=1, global_burst=0,
            per_agent_rate=100, per_agent_burst=100,
            per_execution_rate=100, per_execution_burst=100,
        )
        try:
            limiter.check("agent-1", "exec-1")
            assert False, "Should have raised"
        except RateLimitExceeded as e:
            assert e.limit_type == "global"

    def test_per_agent_limit(self):
        limiter = RateLimiter(
            global_rate=100, global_burst=100,
            per_agent_rate=0.01, per_agent_burst=0,
            per_execution_rate=100, per_execution_burst=100,
        )
        try:
            limiter.check("agent-1", "exec-1")
            assert False, "Should have raised"
        except RateLimitExceeded as e:
            assert e.limit_type == "per_agent"

    def test_per_execution_limit(self):
        limiter = RateLimiter(
            global_rate=100, global_burst=100,
            per_agent_rate=100, per_agent_burst=100,
            per_execution_rate=0.01, per_execution_burst=0,
        )
        try:
            limiter.check("agent-1", "exec-1")
            assert False, "Should have raised"
        except RateLimitExceeded as e:
            assert e.limit_type == "per_execution"

    def test_is_allowed_returns_false(self):
        limiter = RateLimiter(
            global_rate=100, global_burst=100,
            per_agent_rate=0.01, per_agent_burst=0,
            per_execution_rate=100, per_execution_burst=100,
        )
        assert not limiter.is_allowed("agent-1")

    def test_cleanup_execution(self):
        self.limiter.check("agent-1", "exec-99")
        self.limiter.cleanup_execution("exec-99")
        assert "exec-99" not in self.limiter._execution_buckets

    def test_different_agents_dont_share_limits(self):
        limiter = RateLimiter(
            global_rate=1000, global_burst=1000,
            per_agent_rate=0.01, per_agent_burst=0,
            per_execution_rate=100, per_execution_burst=100,
        )
        try:
            limiter.check("agent-1", "exec-1")
            assert False, "agent-1 should be rate limited"
        except RateLimitExceeded:
            pass
        # agent-2 has its own bucket (also empty), should also fail
        try:
            limiter.check("agent-2", "exec-2")
            assert False, "agent-2 should also be rate limited"
        except RateLimitExceeded:
            pass
