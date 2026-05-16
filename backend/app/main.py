from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.onboarding import router as onboarding_router
from app.api.companies import router as companies_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="TACKTCIX — Company Creation Engine",
    description="Strategic onboarding interview, vision-to-knowledge-graph conversion, and company generation pipeline.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(onboarding_router)
app.include_router(companies_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "tacktcix-onboarding-engine"}
