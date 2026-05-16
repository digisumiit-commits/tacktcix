"""Generates a phased roadmap from vision and knowledge graph."""

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.company import Roadmap


class RoadmapService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate(self, company_id: UUID, vision: str, knowledge_nodes: dict | None) -> Roadmap:
        phases = self._generate_phases(vision, knowledge_nodes)
        milestones = self._generate_milestones(phases)
        timeline = self._generate_timeline(phases)
        priorities = self._determine_priorities(phases)

        roadmap = Roadmap(
            company_id=company_id,
            phases=phases,
            milestones=milestones,
            timeline=timeline,
            priorities=priorities,
        )
        self.db.add(roadmap)
        await self.db.flush()
        return roadmap

    def _generate_phases(self, vision: str, nodes: dict | None) -> dict:
        return {
            "phase_1_foundation": {
                "name": "Foundation",
                "order": 1,
                "duration_weeks": 4,
                "objective": "Core platform, auth, database, and basic UI scaffold.",
                "deliverables": [
                    "User authentication (signup/login)",
                    "Company creation flow",
                    "Database schema and migrations",
                    "Core API framework",
                    "Basic UI shell with navigation",
                ],
                "agent_assignments": {
                    "cto": ["architecture design", "database schema"],
                    "frontend_dev": ["UI shell", "auth pages"],
                    "backend_dev": ["API framework", "auth endpoints"],
                    "devops": ["CI/CD pipeline", "staging environment"],
                },
            },
            "phase_2_onboarding": {
                "name": "Onboarding Engine",
                "order": 2,
                "duration_weeks": 3,
                "objective": "Strategic onboarding interview, knowledge graph generation, and company constitution.",
                "deliverables": [
                    "Multi-step onboarding interview",
                    "Vision-to-knowledge-graph pipeline",
                    "Constitution generation",
                    "Roadmap generation",
                    "Initial task creation",
                ],
                "agent_assignments": {
                    "pm": ["onboarding flow design"],
                    "frontend_dev": ["onboarding UI", "dashboard"],
                    "backend_dev": ["knowledge graph service", "generation pipeline"],
                    "ai_dev": ["vision analysis", "generation models"],
                },
            },
            "phase_3_agent_system": {
                "name": "Agent Operating System",
                "order": 3,
                "duration_weeks": 4,
                "objective": "Specialized AI agents with heartbeat scheduling and task orchestration.",
                "deliverables": [
                    "Agent definitions (CEO, CTO, PM, Dev, QA)",
                    "Heartbeat scheduling system",
                    "Task orchestration engine",
                    "Agent-to-agent communication",
                    "Execution worker runtime",
                ],
                "agent_assignments": {
                    "cto": ["agent architecture", "orchestration design"],
                    "backend_dev": ["task engine", "heartbeat system"],
                    "ai_dev": ["agent personalities", "prompt engineering"],
                    "devops": ["execution container runtime"],
                },
            },
            "phase_4_memory": {
                "name": "Memory & Knowledge",
                "order": 4,
                "duration_weeks": 3,
                "objective": "Multi-layer memory system with PostgreSQL, Qdrant vector store, and Neo4j graph.",
                "deliverables": [
                    "Founder memory layer",
                    "Company constitution store",
                    "Project memory (PostgreSQL + Qdrant)",
                    "Agent episodic memory",
                    "Memory retrieval and search",
                ],
                "agent_assignments": {
                    "cto": ["memory architecture"],
                    "backend_dev": ["memory APIs", "storage layer"],
                    "ai_dev": ["vector embeddings", "semantic search"],
                    "devops": ["Neo4j deployment", "Qdrant setup"],
                },
            },
            "phase_5_execution": {
                "name": "Execution & Deployment",
                "order": 5,
                "duration_weeks": 4,
                "objective": "Browser automation, code generation, deployment pipelines, and monitoring.",
                "deliverables": [
                    "Browser automation infrastructure",
                    "Code generation pipeline",
                    "Deployment pipeline (Vercel/Railway)",
                    "Monitoring and observability",
                    "Human approval dashboard",
                ],
                "agent_assignments": {
                    "cto": ["deployment architecture", "monitoring design"],
                    "frontend_dev": ["approval dashboard", "monitoring UI"],
                    "backend_dev": ["deployment API", "pipeline integration"],
                    "devops": ["Playwright infrastructure", "CI/CD", "monitoring"],
                    "qa": ["test automation", "validation pipelines"],
                },
            },
            "phase_6_launch": {
                "name": "Launch & Scale",
                "order": 6,
                "duration_weeks": 3,
                "objective": "Production hardening, billing integration, marketplace templates, and public launch.",
                "deliverables": [
                    "Billing and credits system",
                    "Subscription management",
                    "Company templates marketplace",
                    "Production security audit",
                    "Public launch",
                ],
                "agent_assignments": {
                    "pm": ["launch planning", "marketplace design"],
                    "frontend_dev": ["billing UI", "marketplace"],
                    "backend_dev": ["billing integration", "templates API"],
                    "devops": ["production hardening", "security audit"],
                    "qa": ["end-to-end testing", "load testing"],
                },
            },
        }

    def _generate_milestones(self, phases: dict) -> dict:
        milestones = {}
        for phase_key, phase in phases.items():
            milestones[f"milestone_{phase['order']}"] = {
                "name": f"Complete {phase['name']}",
                "phase": phase_key,
                "week": phase["order"] * phase["duration_weeks"],
                "success_criteria": f"All {phase['name']} deliverables deployed and verified.",
            }
        return milestones

    def _generate_timeline(self, phases: dict) -> dict:
        total_weeks = sum(p["duration_weeks"] for p in phases.values())
        return {
            "total_weeks": total_weeks,
            "total_months": round(total_weeks / 4.33, 1),
            "start_phase": "phase_1_foundation",
            "current_phase": "phase_1_foundation",
            "phases_in_order": list(phases.keys()),
        }

    def _determine_priorities(self, phases: dict) -> dict:
        return {
            "now": ["phase_1_foundation"],
            "next": ["phase_2_onboarding"],
            "later": ["phase_3_agent_system", "phase_4_memory", "phase_5_execution"],
            "future": ["phase_6_launch"],
        }
