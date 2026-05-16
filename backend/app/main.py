from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.middleware.tenant import TenantMiddleware

app = FastAPI(
    title="TACKTCIX API",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TenantMiddleware)

app.include_router(health_router, prefix="/api")


@app.get("/api/me")
async def get_tenant_info():
    from app.core.tenant import get_tenant

    tenant_id = get_tenant()
    return {"tenant_id": str(tenant_id) if tenant_id else None}
