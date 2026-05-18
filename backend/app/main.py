from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.onboarding import router as onboarding_router
from app.api.companies import router as companies_router
from app.api.events import router as events_router
from app.api.agents import router as agents_router
from app.core.health import router as health_router
from app.core.metrics import PrometheusMiddleware, metrics_endpoint, metrics_openmetrics_endpoint, metrics_json_endpoint


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="TACKTCIX — Company Creation Engine",
    description="Strategic onboarding interview, vision-to-knowledge-graph conversion, and company generation pipeline.",
    version="0.1.0",
    lifespan=lifespan,
)

# ── Middleware (order matters: metrics outermost) ──────────────────────
app.add_middleware(PrometheusMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────
app.include_router(health_router)  # provides GET /api/health and /api/health/history
app.include_router(onboarding_router)
app.include_router(companies_router)
app.include_router(events_router)
app.include_router(agents_router)

# ── Prometheus metrics endpoints (excluded from middleware tracking) ──
app.add_route("/metrics", metrics_endpoint, include_in_schema=False)
app.add_route("/metrics/openmetrics", metrics_openmetrics_endpoint, include_in_schema=False)
app.add_route("/metrics/api", metrics_json_endpoint, include_in_schema=False)
