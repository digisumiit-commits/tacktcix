"""Onboarding orchestration service — drives the multi-step flow."""

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.company import Company, OnboardingSession
from app.services.knowledge_graph_service import KnowledgeGraphService
from app.services.constitution_service import ConstitutionService
from app.services.roadmap_service import RoadmapService
from app.services.architecture_service import ArchitectureService
from app.services.task_generation_service import TaskGenerationService
from app.services.agent_registry_service import AgentRegistryService
from app.services.task_orchestrator_service import TaskOrchestrator
from app.services.event_service import EventService, EventTypes


STEP_KEYS = [
    "welcome",
    "company_info",
    "vision",
    "models",
    "integrations",
    "review",
    "processing",
    "complete",
]


class OnboardingService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.events = EventService(db)
        self.kg_service = KnowledgeGraphService(db)
        self.constitution_service = ConstitutionService(db)
        self.roadmap_service = RoadmapService(db)
        self.architecture_service = ArchitectureService(db)
        self.task_service = TaskGenerationService(db)
        self.agent_registry = AgentRegistryService(db, self.events)
        self.orchestrator = TaskOrchestrator(db, self.events)

    async def create_company(self, name: str, slug: str, description: str | None = None,
                             industry: str | None = None, size: str | None = None) -> Company:
        company = Company(name=name, slug=slug, description=description,
                          industry=industry, size=size)
        self.db.add(company)
        await self.db.flush()

        # Seed default agent team for the new company
        agents = await self.agent_registry.seed_default_agents(company.id)
        await self.events.workflow_event(
            company_id=company.id,
            workflow_name="Company Setup",
            event="agents_seeded",
            description=f"Seeded {len(agents)} default agents for {name}",
        )

        session = OnboardingSession(company_id=company.id, current_step=0, total_steps=len(STEP_KEYS))
        self.db.add(session)
        await self.db.flush()

        await self.events.task_transition(
            company_id=company.id,
            task_title="Onboarding started",
            old_status="not_started",
            new_status="in_progress",
            source="system",
            description=f"Onboarding session created for {name}",
        )
        return company

    async def get_session(self, company_id: UUID) -> OnboardingSession | None:
        result = await self.db.execute(
            select(OnboardingSession).where(OnboardingSession.company_id == company_id)
        )
        return result.scalar_one_or_none()

    async def advance_step(self, company_id: UUID, step_key: str, data: dict) -> OnboardingSession:
        session = await self.get_session(company_id)
        if not session:
            raise ValueError("Onboarding session not found")

        step_index = STEP_KEYS.index(step_key) if step_key in STEP_KEYS else session.current_step + 1
        session.current_step = step_index
        current_data = session.step_data or {}
        current_data[step_key] = data
        session.step_data = current_data
        await self.db.flush()
        return session

    async def save_vision(self, company_id: UUID, vision_text: str) -> OnboardingSession:
        session = await self.get_session(company_id)
        if not session:
            raise ValueError("Onboarding session not found")

        session.vision_raw = vision_text

        company = await self.db.get(Company, company_id)
        if company:
            company.vision_statement = vision_text

        await self.db.flush()
        return session

    async def save_models(self, company_id: UUID, models: list[dict]) -> Company:
        company = await self.db.get(Company, company_id)
        if not company:
            raise ValueError("Company not found")
        company.selected_models = {"providers": models}
        await self.db.flush()
        return company

    async def save_integrations(self, company_id: UUID, integrations: dict) -> Company:
        company = await self.db.get(Company, company_id)
        if not company:
            raise ValueError("Company not found")
        company.integrations = integrations
        await self.db.flush()
        return company

    async def process_onboarding(self, company_id: UUID) -> dict:
        """Run the full vision-to-structured-output pipeline."""
        session = await self.get_session(company_id)
        if not session or not session.vision_raw:
            raise ValueError("No vision text to process")

        company = await self.db.get(Company, company_id)
        if not company:
            raise ValueError("Company not found")

        vision = session.vision_raw

        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="started",
            description="Starting full vision-to-structured-output pipeline",
        )

        knowledge_graph = await self.kg_service.generate_from_vision(company_id, vision)
        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="knowledge_graph_generated",
            description=f"Generated knowledge graph with {len(knowledge_graph.nodes or {})} nodes",
        )

        constitution = await self.constitution_service.generate(company_id, vision, knowledge_graph.nodes)
        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="constitution_generated",
            description="Company constitution generated from vision",
        )

        roadmap = await self.roadmap_service.generate(company_id, vision, knowledge_graph.nodes)
        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="roadmap_generated",
            description=f"Generated roadmap with {len(roadmap.phases or {})} phases",
        )

        architecture = await self.architecture_service.generate(
            company_id, vision, knowledge_graph.nodes, company.selected_models
        )
        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="architecture_generated",
            description="System architecture plan generated",
        )

        tasks = await self.task_service.generate_tasks(company_id, roadmap.phases)
        workflows = await self.task_service.generate_workflows(company_id, tasks)

        # Route generated tasks to the best-fit agents via the orchestrator
        route_results = await self.orchestrator.assign_tasks(company_id, tasks, batch=True)
        routed_count = sum(1 for r in route_results if r.get("agent_id") is not None)
        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="tasks_routed",
            description=f"Routed {routed_count}/{len(tasks)} tasks to agents via orchestrator",
        )

        await self.events.workflow_event(
            company_id=company_id,
            workflow_name="Onboarding Processing",
            event="tasks_generated",
            description=f"Generated {len(tasks)} tasks and {len(workflows)} workflows",
        )

        company.onboarding_completed = True
        session.status = "completed"
        session.vision_analysis = {
            "domains": knowledge_graph.domains,
            "capabilities": knowledge_graph.capabilities,
        }
        await self.db.flush()

        await self.events.task_transition(
            company_id=company_id,
            task_title="Onboarding completed",
            old_status="in_progress",
            new_status="completed",
            source="system",
            description=f"Onboarding complete for {company.name}",
        )

        return {
            "company": company,
            "knowledge_graph": knowledge_graph,
            "constitution": constitution,
            "roadmap": roadmap,
            "architecture": architecture,
            "tasks": tasks,
            "workflows": workflows,
        }
