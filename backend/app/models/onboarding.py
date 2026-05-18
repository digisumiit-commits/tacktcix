from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import UUID


class CompanyCreate(BaseModel):
    name: str = Field(..., max_length=255)
    slug: str = Field(..., max_length=255)
    description: str | None = None
    industry: str | None = None
    size: str | None = None


class CompanyUpdate(BaseModel):
    name: str | None = Field(None, max_length=255)
    description: str | None = None
    industry: str | None = None
    size: str | None = None


class CompanyResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    description: str | None
    industry: str | None
    size: str | None
    vision_statement: str | None
    selected_models: dict | None
    integrations: dict | None
    onboarding_completed: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OnboardingStepData(BaseModel):
    step: int
    step_key: str
    data: dict = Field(default_factory=dict)


class OnboardingSessionResponse(BaseModel):
    id: UUID
    company_id: UUID
    current_step: int
    total_steps: int
    step_data: dict | None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class VisionUpload(BaseModel):
    vision_text: str
    format: str = "text"


class KnowledgeGraphResponse(BaseModel):
    id: UUID
    company_id: UUID
    nodes: dict | None
    edges: dict | None
    domains: dict | None
    capabilities: dict | None

    model_config = {"from_attributes": True}


class ConstitutionResponse(BaseModel):
    id: UUID
    company_id: UUID
    mission: str | None
    values: dict | None
    principles: dict | None
    governance: dict | None
    operational_rules: dict | None
    full_text: str | None

    model_config = {"from_attributes": True}


class RoadmapResponse(BaseModel):
    id: UUID
    company_id: UUID
    phases: dict | None
    milestones: dict | None
    timeline: dict | None
    priorities: dict | None

    model_config = {"from_attributes": True}


class ArchitecturePlanResponse(BaseModel):
    id: UUID
    company_id: UUID
    tech_stack: dict | None
    system_design: dict | None
    data_models: dict | None
    api_spec: dict | None
    infrastructure: dict | None
    full_text: str | None

    model_config = {"from_attributes": True}


class TaskResponse(BaseModel):
    id: UUID
    company_id: UUID
    title: str
    description: str | None
    status: str
    priority: str
    assignee_role: str | None
    parent_task_id: UUID | None
    dependencies: dict | None
    metadata: dict | None

    model_config = {"from_attributes": True}


class WorkflowResponse(BaseModel):
    id: UUID
    company_id: UUID
    name: str
    description: str | None
    trigger: dict | None
    steps: dict | None
    assigned_agents: dict | None
    is_active: bool

    model_config = {"from_attributes": True}


class ActivityEventResponse(BaseModel):
    id: UUID
    company_id: UUID
    type: str
    source: str
    source_id: str | None
    title: str
    description: str | None
    metadata: dict | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ActivityEventFilter(BaseModel):
    types: list[str] | None = None
    source: str | None = None
    since: datetime | None = None
    before: datetime | None = None
    limit: int = 50


class OnboardingCompleteResponse(BaseModel):
    company: CompanyResponse
    knowledge_graph: KnowledgeGraphResponse | None
    constitution: ConstitutionResponse | None
    roadmap: RoadmapResponse | None
    architecture_plan: ArchitecturePlanResponse | None
    tasks: list[TaskResponse]
    workflows: list[WorkflowResponse]
