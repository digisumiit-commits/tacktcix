"""Agent registry and task routing API endpoints."""

from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.agent import (
    AgentRegister, AgentUpdate, AgentResponse,
    AgentRouteRequest, AgentRouteResult, AgentHeartbeat,
    BatchRouteRequest, BatchRouteResponse,
)
from app.services.agent_registry_service import AgentRegistryService
from app.services.task_orchestrator_service import TaskOrchestrator
from app.services.event_service import EventService

router = APIRouter(prefix="/api/v1/agents", tags=["agents"])


async def get_event_service(db: AsyncSession = Depends(get_db)) -> EventService:
    return EventService(db)


async def get_registry(
    db: AsyncSession = Depends(get_db),
    events: EventService = Depends(get_event_service),
) -> AgentRegistryService:
    return AgentRegistryService(db, events)


async def get_orchestrator(
    db: AsyncSession = Depends(get_db),
    events: EventService = Depends(get_event_service),
) -> TaskOrchestrator:
    return TaskOrchestrator(db, events)


# ── Agent Registry ───────────────────────────────────────────────────────────

@router.get("/{company_id}", response_model=list[AgentResponse])
async def list_agents(
    company_id: UUID,
    role: str | None = None,
    status: str | None = None,
    registry: AgentRegistryService = Depends(get_registry),
):
    return await registry.list_agents(company_id, role=role, status=status)


@router.post("/{company_id}", response_model=AgentResponse, status_code=201)
async def register_agent(
    company_id: UUID,
    payload: AgentRegister,
    registry: AgentRegistryService = Depends(get_registry),
):
    return await registry.register_agent(company_id, payload)


@router.get("/{company_id}/{agent_id}", response_model=AgentResponse)
async def get_agent(
    company_id: UUID,
    agent_id: UUID,
    registry: AgentRegistryService = Depends(get_registry),
):
    agent = await registry.get_agent(agent_id)
    if not agent or agent.company_id != company_id:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.patch("/{company_id}/{agent_id}", response_model=AgentResponse)
async def update_agent(
    company_id: UUID,
    agent_id: UUID,
    payload: AgentUpdate,
    registry: AgentRegistryService = Depends(get_registry),
):
    agent = await registry.update_agent(agent_id, payload)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.delete("/{company_id}/{agent_id}", status_code=204)
async def delete_agent(
    company_id: UUID,
    agent_id: UUID,
    registry: AgentRegistryService = Depends(get_registry),
):
    deleted = await registry.delete_agent(agent_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Agent not found")


# ── Lifecycle ────────────────────────────────────────────────────────────────

@router.post("/{company_id}/seed", response_model=list[AgentResponse])
async def seed_agents(
    company_id: UUID,
    registry: AgentRegistryService = Depends(get_registry),
):
    return await registry.seed_default_agents(company_id)


@router.post("/heartbeat", response_model=AgentResponse)
async def agent_heartbeat(
    payload: AgentHeartbeat,
    registry: AgentRegistryService = Depends(get_registry),
):
    agent = await registry.update_heartbeat(
        payload.agent_id, payload.current_load, payload.status, payload.metadata,
    )
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


# ── Task Routing ─────────────────────────────────────────────────────────────

@router.post("/{company_id}/route", response_model=AgentRouteResult)
async def route_subtask(
    company_id: UUID,
    request: AgentRouteRequest,
    orchestrator: TaskOrchestrator = Depends(get_orchestrator),
):
    try:
        return await orchestrator.route_task(company_id, request)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/{company_id}/route-to-role", response_model=AgentRouteResult)
async def route_subtask_to_role(
    company_id: UUID,
    request: AgentRouteRequest,
    preferred_role: str,
    orchestrator: TaskOrchestrator = Depends(get_orchestrator),
):
    try:
        return await orchestrator.route_task_to_role(company_id, request, preferred_role)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/{company_id}/batch-route", response_model=BatchRouteResponse)
async def batch_route_subtasks(
    company_id: UUID,
    request: BatchRouteRequest,
    orchestrator: TaskOrchestrator = Depends(get_orchestrator),
):
    """Route multiple sub-tasks across agents in a single coordinated pass."""
    return await orchestrator.batch_route_tasks(company_id, request.tasks)


@router.post("/{company_id}/assign-subtask", status_code=204)
async def assign_subtask(
    company_id: UUID,
    task_id: UUID,
    agent_id: UUID,
    task_title: str | None = None,
    orchestrator: TaskOrchestrator = Depends(get_orchestrator),
):
    """Commit a routed sub-task assignment — increments the agent's load counter."""
    await orchestrator.assign_subtask(task_id, agent_id, task_title)
    return None


@router.post("/{company_id}/complete-subtask", status_code=204)
async def complete_subtask(
    company_id: UUID,
    task_id: UUID,
    agent_id: UUID,
    task_title: str | None = None,
    orchestrator: TaskOrchestrator = Depends(get_orchestrator),
):
    """Mark a sub-task as completed — decrements the agent's load counter."""
    await orchestrator.complete_subtask(task_id, agent_id, task_title)
    return None
