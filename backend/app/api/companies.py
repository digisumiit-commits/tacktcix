from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.company import Company
from app.models.onboarding import CompanyResponse, CompanyUpdate

router = APIRouter(prefix="/api/v1/companies", tags=["companies"])


@router.get("/", response_model=list[CompanyResponse])
async def list_companies(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Company).order_by(Company.created_at.desc()))
    return result.scalars().all()


@router.get("/{company_id}", response_model=CompanyResponse)
async def get_company(company_id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Company).where(Company.id == company_id))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    return company


@router.patch("/{company_id}", response_model=CompanyResponse)
async def update_company(company_id: UUID, payload: CompanyUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Company).where(Company.id == company_id))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    if payload.name is not None:
        company.name = payload.name
    if payload.description is not None:
        company.description = payload.description
    if payload.industry is not None:
        company.industry = payload.industry
    if payload.size is not None:
        company.size = payload.size

    await db.flush()
    return company


@router.get("/{company_id}/dashboard")
async def get_dashboard(company_id: UUID, db: AsyncSession = Depends(get_db)):
    company_result = await db.execute(select(Company).where(Company.id == company_id))
    company = company_result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    from app.models.company import KnowledgeGraph, Constitution, Roadmap, ArchitecturePlan, Task, Workflow

    kg_result = await db.execute(select(KnowledgeGraph).where(KnowledgeGraph.company_id == company_id))
    const_result = await db.execute(select(Constitution).where(Constitution.company_id == company_id))
    roadmap_result = await db.execute(select(Roadmap).where(Roadmap.company_id == company_id))
    arch_result = await db.execute(select(ArchitecturePlan).where(ArchitecturePlan.company_id == company_id))
    tasks_result = await db.execute(select(Task).where(Task.company_id == company_id))
    wf_result = await db.execute(select(Workflow).where(Workflow.company_id == company_id))

    return {
        "company": CompanyResponse.model_validate(company).model_dump(),
        "knowledge_graph": kg_result.scalar_one_or_none(),
        "constitution": const_result.scalar_one_or_none(),
        "roadmap": roadmap_result.scalar_one_or_none(),
        "architecture_plan": arch_result.scalar_one_or_none(),
        "tasks": [t for t in tasks_result.scalars().all()],
        "workflows": [w for w in wf_result.scalars().all()],
        "stats": {
            "total_tasks": len(tasks_result.scalars().all()),
            "active_workflows": sum(1 for w in wf_result.scalars().all() if w.is_active),
            "onboarding_complete": company.onboarding_completed,
        },
    }
