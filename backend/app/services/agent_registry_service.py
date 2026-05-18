"""Agent registry — manages agent lifecycle, capability discovery, and load tracking."""

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.agent import Agent, AgentRegister, AgentUpdate
from app.services.event_service import EventService, EventTypes


# Proficiency mappings for standard agent roles (used when seeding defaults).
# Each maps domain → proficiency (0.0 – 1.0).
ROLE_CAPABILITIES: dict[str, dict[str, float]] = {
    "ceo": {
        "business": 1.0,
        "strategy": 1.0,
        "governance": 0.9,
        "communication": 0.9,
        "leadership": 1.0,
    },
    "cto": {
        "backend": 0.9,
        "architecture": 1.0,
        "infrastructure": 0.9,
        "security": 0.8,
        "code_review": 0.9,
    },
    "pm": {
        "product": 1.0,
        "planning": 1.0,
        "communication": 0.9,
        "analytics": 0.7,
        "stakeholder": 0.9,
    },
    "frontend_dev": {
        "frontend": 1.0,
        "ui": 1.0,
        "design": 0.7,
        "accessibility": 0.7,
        "frontend_testing": 0.8,
    },
    "backend_dev": {
        "backend": 1.0,
        "api": 1.0,
        "database": 0.9,
        "security": 0.6,
        "backend_testing": 0.8,
    },
    "ai_dev": {
        "ai_ml": 1.0,
        "nlp": 0.9,
        "prompt_engineering": 1.0,
        "data_science": 0.8,
        "model_deployment": 0.8,
    },
    "devops": {
        "infrastructure": 1.0,
        "ci_cd": 1.0,
        "cloud": 1.0,
        "monitoring": 0.8,
        "security": 0.7,
    },
    "qa": {
        "testing": 1.0,
        "automation": 0.9,
        "security_testing": 0.6,
        "performance": 0.7,
        "documentation": 0.6,
    },
    "designer": {
        "design": 1.0,
        "ui": 1.0,
        "ux": 1.0,
        "accessibility": 0.8,
        "prototyping": 0.9,
    },
    "marketing": {
        "content_creation": 1.0,
        "campaign_management": 1.0,
        "analytics": 0.9,
        "seo": 0.8,
        "social_media": 0.9,
        "email_marketing": 0.8,
        "brand_strategy": 0.9,
        "market_research": 0.7,
    },
}

ROLE_COST: dict[str, float] = {
    "ceo": 3.0,
    "cto": 2.5,
    "pm": 2.0,
    "frontend_dev": 1.0,
    "backend_dev": 1.0,
    "ai_dev": 1.5,
    "devops": 1.5,
    "qa": 0.8,
    "designer": 1.2,
    "marketing": 1.2,
}


class AgentRegistryService:
    """Registry for managing AI agents, their capabilities, and load."""

    def __init__(self, db: AsyncSession, events: EventService | None = None):
        self.db = db
        self.events = events

    # ── CRUD ────────────────────────────────────────────────────────────────

    async def register_agent(self, company_id: UUID, payload: AgentRegister) -> Agent:
        """Register a new agent in the registry."""
        agent = Agent(
            company_id=company_id,
            role=payload.role,
            name=payload.name,
            description=payload.description,
            capabilities=payload.capabilities or ROLE_CAPABILITIES.get(payload.role, {}),
            cost_per_task=payload.cost_per_task if payload.cost_per_task != 1.0 else ROLE_COST.get(payload.role, 1.0),
            max_concurrent_tasks=payload.max_concurrent_tasks,
            metadata=payload.metadata,
            status="idle",
            current_load=0,
        )
        self.db.add(agent)
        await self.db.flush()

        if self.events:
            await self.events.agent_action(
                company_id=company_id,
                agent_name=agent.name,
                action=f"Agent {agent.name} registered",
                source_id=str(agent.id),
                description=f"{agent.role} agent registered with {len(agent.capabilities or {})} capabilities",
            )
        return agent

    async def get_agent(self, agent_id: UUID) -> Agent | None:
        result = await self.db.execute(select(Agent).where(Agent.id == agent_id))
        return result.scalar_one_or_none()

    async def update_agent(self, agent_id: UUID, payload: AgentUpdate) -> Agent | None:
        agent = await self.get_agent(agent_id)
        if not agent:
            return None

        update_data = payload.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(agent, field, value)
        await self.db.flush()
        return agent

    async def list_agents(self, company_id: UUID, role: str | None = None,
                          status: str | None = None) -> list[Agent]:
        stmt = select(Agent).where(Agent.company_id == company_id)
        if role:
            stmt = stmt.where(Agent.role == role)
        if status:
            stmt = stmt.where(Agent.status == status)
        stmt = stmt.order_by(Agent.role)
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def delete_agent(self, agent_id: UUID) -> bool:
        agent = await self.get_agent(agent_id)
        if not agent:
            return False
        await self.db.delete(agent)
        await self.db.flush()
        return True

    # ── Lifecycle & load ────────────────────────────────────────────────────

    async def seed_default_agents(self, company_id: UUID) -> list[Agent]:
        """Create the standard TACKTCIX agent team for a new company."""
        # Check if already seeded
        existing = await self.list_agents(company_id)
        if existing:
            return existing

        defaults = [
            AgentRegister(role="ceo", name="CEO Agent", description="Strategic direction, governance, and team orchestration."),
            AgentRegister(role="cto", name="CTO Agent", description="Technical architecture, engineering leadership, and code review."),
            AgentRegister(role="pm", name="PM Agent", description="Product vision, roadmap, priorities, and stakeholder alignment."),
            AgentRegister(role="frontend_dev", name="Frontend Agent", description="UI/UX implementation with Next.js and Tailwind."),
            AgentRegister(role="backend_dev", name="Backend Agent", description="API and server development with FastAPI."),
            AgentRegister(role="ai_dev", name="AI Agent", description="LLM integration, prompt engineering, and AI features."),
            AgentRegister(role="devops", name="DevOps Agent", description="Infrastructure, CI/CD, Docker, and Kubernetes."),
            AgentRegister(role="qa", name="QA Agent", description="Testing, quality assurance, and validation."),
            AgentRegister(role="designer", name="Designer Agent", description="UX design, interface design, and prototyping."),
            AgentRegister(role="marketing", name="Marketing Agent", description="Content generation, campaign management, and performance analytics."),
        ]

        agents = []
        for reg in defaults:
            agent = await self.register_agent(company_id, reg)
            agents.append(agent)

        return agents

    async def update_heartbeat(self, agent_id: UUID, current_load: int,
                               status: str, metadata: dict | None = None) -> Agent | None:
        """Process a heartbeat from an agent — updates load and status."""
        agent = await self.get_agent(agent_id)
        if not agent:
            return None
        agent.current_load = current_load
        agent.status = status
        if metadata:
            agent.metadata = {**(agent.metadata or {}), **metadata}
        await self.db.flush()
        return agent

    async def assign_task(self, agent_id: UUID, task_title: str | None = None) -> Agent | None:
        """Increment load when a task is assigned to an agent."""
        agent = await self.get_agent(agent_id)
        if not agent:
            return None
        agent.current_load += 1
        if agent.current_load >= agent.max_concurrent_tasks:
            agent.status = "busy"
        await self.db.flush()

        if self.events:
            await self.events.task_transition(
                company_id=agent.company_id,
                task_title=task_title or f"Task assigned to {agent.name}",
                old_status="pending",
                new_status="assigned",
                source=agent.role,
                source_id=str(agent_id),
                description=f"Assigned to {agent.name} (load: {agent.current_load}/{agent.max_concurrent_tasks})",
                metadata={"agent_role": agent.role, "agent_load": agent.current_load},
            )
        return agent

    async def complete_task(self, agent_id: UUID, task_title: str | None = None) -> Agent | None:
        """Decrement load when a task is completed."""
        agent = await self.get_agent(agent_id)
        if not agent:
            return None
        agent.current_load = max(0, agent.current_load - 1)
        if agent.current_load < agent.max_concurrent_tasks:
            agent.status = "idle"
        await self.db.flush()

        if self.events:
            await self.events.task_transition(
                company_id=agent.company_id,
                task_title=task_title or f"Task completed by {agent.name}",
                old_status="assigned",
                new_status="completed",
                source=agent.role,
                source_id=str(agent_id),
                description=f"Completed by {agent.name} (load: {agent.current_load}/{agent.max_concurrent_tasks})",
                metadata={"agent_role": agent.role, "agent_load": agent.current_load},
            )
        return agent
