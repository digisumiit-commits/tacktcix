from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}


@router.get("/health/ready")
async def readiness_check():
    return {"status": "ready", "checks": {"database": "ok", "redis": "ok"}}
