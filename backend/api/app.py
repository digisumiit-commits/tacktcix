import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI
from fastapi.responses import JSONResponse

try:
    from app.main import app as _app
    app = _app
except Exception as e:
    import traceback
    app = FastAPI()

    @app.get("/api/health")
    async def health():
        return {"status": "degraded", "error": str(e)[:200]}

    @app.api_route("/{path:path}")
    async def error(path: str):
        return JSONResponse(
            status_code=500,
            content={"error": "startup_failed", "detail": str(e), "tb": traceback.format_exc()[-500:]},
        )
