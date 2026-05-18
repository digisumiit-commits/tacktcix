"""Token bucket rate limiter with optional Redis-backed distributed enforcement.

Supports per-company, per-agent, and per-execution rate limits.
"""

import time
from dataclasses import dataclass
from typing import Optional


class RateLimitExceeded(Exception):
    def __init__(self, retry_after_s: float, limit_type: str, actor_id: str):
        self.retry_after_s = retry_after_s
        self.limit_type = limit_type
        self.actor_id = actor_id
        super().__init__(
            f"Rate limit exceeded for {actor_id} ({limit_type}). "
            f"Retry after {retry_after_s:.1f}s"
        )


@dataclass
class TokenBucket:
    """In-memory token bucket for single-process rate limiting."""

    rate: float       # tokens per second
    burst: int        # max burst size
    tokens: float = 0.0
    last_refill: float = 0.0

    def __post_init__(self):
        self.tokens = float(self.burst)
        self.last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(float(self.burst), self.tokens + elapsed * self.rate)
        self.last_refill = now

    def consume(self, n: int = 1) -> bool:
        """Try to consume n tokens. Returns True if allowed."""
        self._refill()
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False

    def retry_after(self) -> float:
        """Seconds until next token is available."""
        self._refill()
        if self.tokens >= 1:
            return 0.0
        return (1.0 - self.tokens) / self.rate


class RateLimiter:
    """Multi-scope rate limiter (global, per-agent, per-execution).

    Uses in-memory token buckets by default. Set redis_client for distributed enforcement.
    """

    def __init__(
        self,
        global_rate: float = 100,
        global_burst: int = 200,
        per_agent_rate: float = 20,
        per_agent_burst: int = 40,
        per_execution_rate: float = 5,
        per_execution_burst: int = 10,
        redis_client=None,
        redis_key_prefix: str = "ratelimit",
        window_size_s: int = 60,
    ):
        self.global_rate = global_rate
        self.global_burst = global_burst
        self.per_agent_rate = per_agent_rate
        self.per_agent_burst = per_agent_burst
        self.per_execution_rate = per_execution_rate
        self.per_execution_burst = per_execution_burst

        self.redis = redis_client
        self.redis_prefix = redis_key_prefix
        self.window_size_s = window_size_s

        # In-memory fallback buckets
        self._global_bucket = TokenBucket(rate=global_rate, burst=global_burst)
        self._agent_buckets: dict[str, TokenBucket] = {}
        self._execution_buckets: dict[str, TokenBucket] = {}

    def _check_redis(self, key: str, rate: float, burst: int) -> tuple[bool, float]:
        """Distributed rate check using sorted set sliding window."""
        if self.redis is None:
            return True, 0.0

        now_ms = int(time.time() * 1000)
        window_start = now_ms - (self.window_size_s * 1000)
        redis_key = f"{self.redis_prefix}:{key}"

        pipe = self.redis.pipeline()
        pipe.zremrangebyscore(redis_key, 0, window_start)
        pipe.zcard(redis_key)
        pipe.zadd(redis_key, {str(now_ms): now_ms})
        pipe.expire(redis_key, self.window_size_s + 10)
        _, count, _, _ = pipe.execute()

        if count > burst:
            oldest = self.redis.zrange(redis_key, 0, 0, withscores=True)
            if oldest:
                retry_ms = max(0, oldest[0][1] + self.window_size_s * 1000 - now_ms)
                return False, retry_ms / 1000.0
            return False, 1.0

        return True, 0.0

    def _get_agent_bucket(self, agent_id: str) -> TokenBucket:
        if agent_id not in self._agent_buckets:
            self._agent_buckets[agent_id] = TokenBucket(
                rate=self.per_agent_rate, burst=self.per_agent_burst
            )
        return self._agent_buckets[agent_id]

    def _get_execution_bucket(self, execution_id: str) -> TokenBucket:
        if execution_id not in self._execution_buckets:
            self._execution_buckets[execution_id] = TokenBucket(
                rate=self.per_execution_rate, burst=self.per_execution_burst
            )
        return self._execution_buckets[execution_id]

    # --- Public API ---

    def check(self, agent_id: str, execution_id: Optional[str] = None) -> None:
        """Check all rate limits. Raises RateLimitExceeded if any limit is hit."""

        # Global limit
        if self.redis:
            allowed, retry = self._check_redis("global", self.global_rate, self.global_burst)
        else:
            allowed = self._global_bucket.consume(1)
            retry = self._global_bucket.retry_after()

        if not allowed:
            raise RateLimitExceeded(retry, "global", agent_id)

        # Per-agent limit
        if self.redis:
            allowed, retry = self._check_redis(f"agent:{agent_id}", self.per_agent_rate, self.per_agent_burst)
        else:
            bucket = self._get_agent_bucket(agent_id)
            allowed = bucket.consume(1)
            retry = bucket.retry_after()

        if not allowed:
            raise RateLimitExceeded(retry, "per_agent", agent_id)

        # Per-execution limit
        if execution_id:
            if self.redis:
                allowed, retry = self._check_redis(f"exec:{execution_id}", self.per_execution_rate, self.per_execution_burst)
            else:
                bucket = self._get_execution_bucket(execution_id)
                allowed = bucket.consume(1)
                retry = bucket.retry_after()

            if not allowed:
                raise RateLimitExceeded(retry, "per_execution", agent_id)

    def is_allowed(self, agent_id: str, execution_id: Optional[str] = None) -> bool:
        """Check if request is allowed without raising."""
        try:
            self.check(agent_id, execution_id)
            return True
        except RateLimitExceeded:
            return False

    def cleanup_execution(self, execution_id: str) -> None:
        """Remove execution-specific rate limit state."""
        self._execution_buckets.pop(execution_id, None)
        if self.redis:
            self.redis.delete(f"{self.redis_prefix}:exec:{execution_id}")
