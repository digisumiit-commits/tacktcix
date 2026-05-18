"""Agent model and Pydantic schemas for the agent registry."""

import uuid
from datetime import datetime
from typing import Any
from sqlalchemy import String, DateTime, JSON, Float, Integer
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID
from pydantic import BaseModel, Field

from app.core.database import Base


# ── SQLAlchemy Model ──────────────────────────────────────────────────────────

class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(50), default="idle")       # idle | busy | offline
    capabilities: Mapped[dict[str, Any] | None] = mapped_column(JSON)      # {domain: proficiency (0-1), ...}
    cost_per_task: Mapped[float] = mapped_column(Float, default=1.0)       # relative cost unit
    max_concurrent_tasks: Mapped[int] = mapped_column(Integer, default=3)
    current_load: Mapped[int] = mapped_column(Integer, default=0)          # active tasks count
    meta: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ── Pydantic Schemas ─────────────────────────────────────────────────────────

class AgentRegister(BaseModel):
    role: str = Field(..., max_length=100)
    name: str = Field(..., max_length=255)
    description: str | None = None
    capabilities: dict[str, float] | None = None        # domain → proficiency (0.0 – 1.0)
    cost_per_task: float = Field(default=1.0, ge=0.0)
    max_concurrent_tasks: int = Field(default=3, ge=1)
    metadata: dict | None = None


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    status: str | None = None
    capabilities: dict[str, float] | None = None
    cost_per_task: float | None = None
    max_concurrent_tasks: int | None = None
    metadata: dict | None = None


class AgentResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    role: str
    name: str
    description: str | None
    status: str
    capabilities: dict | None
    cost_per_task: float
    max_concurrent_tasks: int
    current_load: int
    metadata: dict | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AgentRouteRequest(BaseModel):
    """Describes a sub-task that needs routing to an agent."""
    task_title: str = Field(..., max_length=500)
    task_description: str | None = None
    required_domains: list[str] = Field(default_factory=list)   # e.g. ["frontend", "api"]
    estimated_complexity: float = Field(default=1.0, ge=0.1, le=10.0)
    priority: str = "medium"


class AgentRouteResult(BaseModel):
    """Result of routing a sub-task to an agent."""
    agent_id: uuid.UUID
    agent_role: str
    agent_name: str
    score: float
    breakdown: dict[str, float] = {}          # capability / load / cost sub-scores
    reason: str = ""
    task_title: str | None = None             # populated by batch routing for traceability


class AgentHeartbeat(BaseModel):
    agent_id: uuid.UUID
    company_id: uuid.UUID
    current_load: int
    status: str
    metadata: dict | None = None


class BatchRouteRequest(BaseModel):
    """Request to route multiple sub-tasks across agents."""
    tasks: list[AgentRouteRequest] = Field(..., min_length=1, max_length=100)


class BatchRouteResponse(BaseModel):
    """Result of batch-routing multiple sub-tasks across agents."""
    assignments: list[AgentRouteResult]
    unassigned: list[str] = []       # task titles that could not be routed
