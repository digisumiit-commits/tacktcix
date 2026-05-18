import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, JSON, Text, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    industry: Mapped[str | None] = mapped_column(String(255))
    size: Mapped[str | None] = mapped_column(String(50))
    vision_statement: Mapped[str | None] = mapped_column(Text)
    selected_models: Mapped[dict | None] = mapped_column(JSON)
    integrations: Mapped[dict | None] = mapped_column(JSON)
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    knowledge_graph = relationship("KnowledgeGraph", back_populates="company", uselist=False)
    constitution = relationship("Constitution", back_populates="company", uselist=False)
    roadmap = relationship("Roadmap", back_populates="company", uselist=False)
    architecture_plan = relationship("ArchitecturePlan", back_populates="company", uselist=False)
    onboarding_session = relationship("OnboardingSession", back_populates="company", uselist=False)


class OnboardingSession(Base):
    __tablename__ = "onboarding_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"), unique=True)
    current_step: Mapped[int] = mapped_column(default=0)
    total_steps: Mapped[int] = mapped_column(default=7)
    step_data: Mapped[dict | None] = mapped_column(JSON, default=dict)
    vision_raw: Mapped[str | None] = mapped_column(Text)
    vision_analysis: Mapped[dict | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(50), default="in_progress")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    company = relationship("Company", back_populates="onboarding_session")


class KnowledgeGraph(Base):
    __tablename__ = "knowledge_graphs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"), unique=True)
    nodes: Mapped[dict | None] = mapped_column(JSON)
    edges: Mapped[dict | None] = mapped_column(JSON)
    domains: Mapped[dict | None] = mapped_column(JSON)
    capabilities: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    company = relationship("Company", back_populates="knowledge_graph")


class Constitution(Base):
    __tablename__ = "constitutions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"), unique=True)
    mission: Mapped[str | None] = mapped_column(Text)
    values: Mapped[dict | None] = mapped_column(JSON)
    principles: Mapped[dict | None] = mapped_column(JSON)
    governance: Mapped[dict | None] = mapped_column(JSON)
    operational_rules: Mapped[dict | None] = mapped_column(JSON)
    full_text: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    company = relationship("Company", back_populates="constitution")


class Roadmap(Base):
    __tablename__ = "roadmaps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"), unique=True)
    phases: Mapped[dict | None] = mapped_column(JSON)
    milestones: Mapped[dict | None] = mapped_column(JSON)
    timeline: Mapped[dict | None] = mapped_column(JSON)
    priorities: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    company = relationship("Company", back_populates="roadmap")


class ArchitecturePlan(Base):
    __tablename__ = "architecture_plans"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"), unique=True)
    tech_stack: Mapped[dict | None] = mapped_column(JSON)
    system_design: Mapped[dict | None] = mapped_column(JSON)
    data_models: Mapped[dict | None] = mapped_column(JSON)
    api_spec: Mapped[dict | None] = mapped_column(JSON)
    infrastructure: Mapped[dict | None] = mapped_column(JSON)
    full_text: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    company = relationship("Company", back_populates="architecture_plan")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"))
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(50), default="todo")
    priority: Mapped[str] = mapped_column(String(50), default="medium")
    assignee_role: Mapped[str | None] = mapped_column(String(100))
    assignee_agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("agents.id"), nullable=True)
    parent_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("tasks.id"))
    dependencies: Mapped[dict | None] = mapped_column(JSON)
    metadata: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"))
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    trigger: Mapped[dict | None] = mapped_column(JSON)
    steps: Mapped[dict | None] = mapped_column(JSON)
    assigned_agents: Mapped[dict | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ActivityEvent(Base):
    __tablename__ = "activity_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("companies.id"), index=True)
    type: Mapped[str] = mapped_column(String(50), index=True)
    source: Mapped[str] = mapped_column(String(100))
    source_id: Mapped[str | None] = mapped_column(String(255))
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text)
    metadata: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    __table_args__ = (
        {"indexes": [
            # Composite index for the common query pattern: events for a company ordered by time
        ]},
    )
