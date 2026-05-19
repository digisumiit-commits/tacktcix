from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.onboarding import (
    CompanyCreate, CompanyResponse, CompanyUpdate,
    VisionUpload, OnboardingStepData,
    OnboardingSessionResponse,
    KnowledgeGraphResponse,
    ConstitutionResponse,
    RoadmapResponse,
    ArchitecturePlanResponse,
    TaskResponse,
    WorkflowResponse,
    OnboardingCompleteResponse,
)
from app.models.company import Company
from app.services.onboarding_service import OnboardingService, STEP_KEYS

router = APIRouter(prefix="/api/v1/onboarding", tags=["onboarding"])


async def get_onboarding_service(db: AsyncSession = Depends(get_db)) -> OnboardingService:
    return OnboardingService(db)


@router.post("/start", response_model=OnboardingSessionResponse)
async def start_onboarding(
    payload: CompanyCreate,
    service: OnboardingService = Depends(get_onboarding_service),
):
    try:
        company = await service.create_company(
            name=payload.name,
            slug=payload.slug,
            description=payload.description,
            industry=payload.industry,
            size=payload.size,
        )
        session = await service.get_session(company.id)
        return _session_response(session)
    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n{traceback.format_exc()}")


@router.post("/{company_id}/step", response_model=OnboardingSessionResponse)
async def save_step(
    company_id: UUID,
    payload: OnboardingStepData,
    service: OnboardingService = Depends(get_onboarding_service),
):
    session = await service.advance_step(company_id, payload.step_key, payload.data)
    return _session_response(session)


@router.post("/{company_id}/vision", response_model=OnboardingSessionResponse)
async def upload_vision(
    company_id: UUID,
    payload: VisionUpload,
    service: OnboardingService = Depends(get_onboarding_service),
):
    session = await service.save_vision(company_id, payload.vision_text)
    return _session_response(session)


@router.post("/{company_id}/models")
async def select_models(
    company_id: UUID,
    models: list[dict],
    service: OnboardingService = Depends(get_onboarding_service),
):
    company = await service.save_models(company_id, models)
    return {"status": "ok", "models": company.selected_models}


@router.post("/{company_id}/integrations")
async def save_integrations(
    company_id: UUID,
    integrations: dict,
    service: OnboardingService = Depends(get_onboarding_service),
):
    company = await service.save_integrations(company_id, integrations)
    return {"status": "ok", "integrations": company.integrations}


@router.post("/{company_id}/process", response_model=OnboardingCompleteResponse)
async def process_onboarding(
    company_id: UUID,
    service: OnboardingService = Depends(get_onboarding_service),
):
    try:
        result = await service.process_onboarding(company_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _complete_response(result)


@router.get("/{company_id}/session", response_model=OnboardingSessionResponse)
async def get_session(
    company_id: UUID,
    service: OnboardingService = Depends(get_onboarding_service),
):
    session = await service.get_session(company_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_response(session)


@router.get("/{company_id}/knowledge-graph", response_model=KnowledgeGraphResponse)
async def get_knowledge_graph(
    company_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models.company import KnowledgeGraph
    result = await db.execute(select(KnowledgeGraph).where(KnowledgeGraph.company_id == company_id))
    kg = result.scalar_one_or_none()
    if not kg:
        raise HTTPException(status_code=404, detail="Knowledge graph not found")
    return kg


@router.get("/{company_id}/constitution", response_model=ConstitutionResponse)
async def get_constitution(
    company_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models.company import Constitution
    result = await db.execute(select(Constitution).where(Constitution.company_id == company_id))
    constitution = result.scalar_one_or_none()
    if not constitution:
        raise HTTPException(status_code=404, detail="Constitution not found")
    return constitution


@router.get("/{company_id}/roadmap", response_model=RoadmapResponse)
async def get_roadmap(
    company_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models.company import Roadmap
    result = await db.execute(select(Roadmap).where(Roadmap.company_id == company_id))
    roadmap = result.scalar_one_or_none()
    if not roadmap:
        raise HTTPException(status_code=404, detail="Roadmap not found")
    return roadmap


@router.get("/{company_id}/architecture", response_model=ArchitecturePlanResponse)
async def get_architecture(
    company_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models.company import ArchitecturePlan
    result = await db.execute(select(ArchitecturePlan).where(ArchitecturePlan.company_id == company_id))
    plan = result.scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="Architecture plan not found")
    return plan


@router.get("/{company_id}/tasks", response_model=list[TaskResponse])
async def get_tasks(
    company_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models.company import Task
    result = await db.execute(select(Task).where(Task.company_id == company_id))
    return result.scalars().all()


@router.get("/{company_id}/workflows", response_model=list[WorkflowResponse])
async def get_workflows(
    company_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models.company import Workflow
    result = await db.execute(select(Workflow).where(Workflow.company_id == company_id))
    return result.scalars().all()


def _session_response(session):
    return OnboardingSessionResponse(
        id=session.id,
        company_id=session.company_id,
        current_step=session.current_step,
        total_steps=session.total_steps,
        step_data=session.step_data,
        status=session.status,
        created_at=session.created_at,
    )


def _complete_response(result: dict) -> OnboardingCompleteResponse:
    company = result["company"]
    kg = result.get("knowledge_graph")
    constitution = result.get("constitution")
    roadmap = result.get("roadmap")
    architecture = result.get("architecture")
    tasks = result.get("tasks", [])
    workflows = result.get("workflows", [])

    return OnboardingCompleteResponse(
        company=CompanyResponse.model_validate(company),
        knowledge_graph=KnowledgeGraphResponse.model_validate(kg) if kg else None,
        constitution=ConstitutionResponse.model_validate(constitution) if constitution else None,
        roadmap=RoadmapResponse.model_validate(roadmap) if roadmap else None,
        architecture_plan=ArchitecturePlanResponse.model_validate(architecture) if architecture else None,
        tasks=[TaskResponse.model_validate(t) for t in tasks],
        workflows=[WorkflowResponse.model_validate(w) for w in workflows],
    )
