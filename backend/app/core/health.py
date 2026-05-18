"""Enhanced health check endpoints with dependency probing and history."""

import time

from fastapi import APIRouter, Query
from sqlalchemy import text

from app.core.database import async_session
from app.core.metrics import get_health_history, record_health_check

router = APIRouter(tags=["health"])


async def _check_database() -> tuple[bool, float]:
    """Ping the database and return (ok, elapsed_ms)."""
    start = time.monotonic()
    try:
        async with async_session() as session:
            await session.execute(text("SELECT 1"))
            elapsed = (time.monotonic() - start) * 1000
            return True, round(elapsed, 1)
    except Exception:
        elapsed = (time.monotonic() - start) * 1000
        return False, round(elapsed, 1)


@router.get("/api/health")
async def health_check():
    """Health check that probes dependencies and returns detailed status.

    Records each check result into an in-memory history buffer (last 100)
    and updates the ``health_check_status`` Prometheus gauge.
    """
    start = time.monotonic()

    db_ok, db_ms = await _check_database()

    checks = {
        "database": db_ok,
    }

    overall = all(checks.values())
    elapsed = (time.monotonic() - start) * 1000

    record_health_check(overall, checks, elapsed)

    return {
        "status": "ok" if overall else "degraded",
        "service": "tacktcix-onboarding-engine",
        "timestamp": time.time(),
        "duration_ms": round(elapsed, 1),
        "checks": {
            "database": {
                "status": "ok" if db_ok else "error",
                "duration_ms": db_ms,
            },
        },
    }


@router.get("/api/health/history")
async def health_history(limit: int = Query(20, ge=1, le=100)):
    """Return recent health check results from the in-memory buffer."""
    return {
        "history": get_health_history(limit),
    }
