"""Generates initial tasks and workflows from the roadmap."""

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.company import Task, Workflow


class TaskGenerationService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate_tasks(self, company_id: UUID, phases: dict | None) -> list[Task]:
        if not phases:
            return []

        tasks = []
        for phase_key, phase in phases.items():
            for i, deliverable in enumerate(phase.get("deliverables", [])):
                task = Task(
                    company_id=company_id,
                    title=f"[{phase['name']}] {deliverable}",
                    description=f"Deliverable for {phase['name']} phase: {deliverable}",
                    status="todo",
                    priority="high" if phase["order"] <= 2 else "medium",
                    assignee_role=self._infer_assignee(deliverable, phase),
                    metadata={"phase": phase_key, "phase_order": phase["order"], "deliverable_index": i},
                )
                self.db.add(task)
                tasks.append(task)

        self._link_dependencies(tasks)
        await self.db.flush()
        return tasks

    def _infer_assignee(self, deliverable: str, phase: dict) -> str:
        dl = deliverable.lower()
        if any(w in dl for w in ["ui", "frontend", "page", "dashboard", "design"]):
            return "frontend_dev"
        if any(w in dl for w in ["api", "backend", "endpoint", "database", "schema"]):
            return "backend_dev"
        if any(w in dl for w in ["ai", "model", "generation", "prompt", "agent personality"]):
            return "ai_dev"
        if any(w in dl for w in ["deploy", "ci/cd", "infrastructure", "docker", "kubernetes", "playwright"]):
            return "devops"
        if any(w in dl for w in ["test", "qa", "validation", "testing"]):
            return "qa"
        if any(w in dl for w in ["architecture", "design system"]):
            return "cto"
        if any(w in dl for w in ["planning", "roadmap", "marketplace"]):
            return "pm"
        return "backend_dev"

    def _link_dependencies(self, tasks: list[Task]):
        """Set sequential dependencies within each phase."""
        phase_tasks = {}
        for task in tasks:
            phase_key = task.metadata.get("phase")
            phase_tasks.setdefault(phase_key, []).append(task)

        for phase_tasks_list in phase_tasks.values():
            phase_tasks_list.sort(key=lambda t: t.metadata.get("deliverable_index", 0))
            for i in range(1, len(phase_tasks_list)):
                prev_task = phase_tasks_list[i - 1]
                current = phase_tasks_list[i]
                current.dependencies = {"depends_on": [str(prev_task.id)], "type": "sequential"}

    async def generate_workflows(self, company_id: UUID, tasks: list[Task]) -> list[Workflow]:
        workflows = []

        workflows.append(Workflow(
            company_id=company_id,
            name="Daily Heartbeat",
            description="Daily agent heartbeat: scan tasks, detect failures, reprioritize, execute.",
            trigger={"type": "schedule", "cron": "*/5 * * * *"},
            steps=[
                {"order": 1, "action": "scan_pending_tasks", "agent": "ceo"},
                {"order": 2, "action": "prioritize_by_dependencies", "agent": "pm"},
                {"order": 3, "action": "assign_to_agents", "agent": "cto"},
                {"order": 4, "action": "execute_tasks", "agent": "all"},
                {"order": 5, "action": "report_status", "agent": "ceo"},
            ],
            assigned_agents={"ceo": True, "cto": True, "pm": True},
        ))

        workflows.append(Workflow(
            company_id=company_id,
            name="Code Review Pipeline",
            description="AI self-review → peer agent review → CTO review → deploy.",
            trigger={"type": "event", "event": "code_generated"},
            steps=[
                {"order": 1, "action": "self_review", "agent": "author"},
                {"order": 2, "action": "peer_review", "agent": "peer"},
                {"order": 3, "action": "cto_review", "agent": "cto"},
                {"order": 4, "action": "sandbox_deploy", "agent": "devops"},
                {"order": 5, "action": "qa_validation", "agent": "qa"},
                {"order": 6, "action": "request_approval", "agent": "cto"},
                {"order": 7, "action": "production_deploy", "agent": "devops"},
            ],
            assigned_agents={"cto": True, "qa": True, "devops": True},
        ))

        workflows.append(Workflow(
            company_id=company_id,
            name="Onboarding Pipeline",
            description="New company onboarding: interview → knowledge graph → constitution → roadmap → tasks.",
            trigger={"type": "event", "event": "company_created"},
            steps=[
                {"order": 1, "action": "conduct_onboarding_interview", "agent": "pm"},
                {"order": 2, "action": "analyze_vision", "agent": "ai_dev"},
                {"order": 3, "action": "generate_knowledge_graph", "agent": "ai_dev"},
                {"order": 4, "action": "generate_constitution", "agent": "ceo"},
                {"order": 5, "action": "generate_roadmap", "agent": "pm"},
                {"order": 6, "action": "generate_architecture", "agent": "cto"},
                {"order": 7, "action": "generate_initial_tasks", "agent": "pm"},
                {"order": 8, "action": "present_dashboard", "agent": "ceo"},
            ],
            assigned_agents={"ceo": True, "cto": True, "pm": True, "ai_dev": True},
        ))

        for wf in workflows:
            self.db.add(wf)

        await self.db.flush()
        return workflows
