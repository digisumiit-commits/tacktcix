"""Generates a company constitution from vision and knowledge graph."""

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.company import Constitution


class ConstitutionService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate(self, company_id: UUID, vision: str, knowledge_nodes: dict | None) -> Constitution:
        constitution = Constitution(
            company_id=company_id,
            mission=self._derive_mission(vision),
            values=self._derive_values(vision),
            principles=self._derive_principles(vision, knowledge_nodes),
            governance=self._derive_governance(knowledge_nodes),
            operational_rules=self._derive_operational_rules(vision, knowledge_nodes),
            full_text=self._generate_full_text(vision),
        )
        self.db.add(constitution)
        await self.db.flush()
        return constitution

    def _derive_mission(self, vision: str) -> str:
        first_sentence = vision.split(".")[0].strip()
        if len(first_sentence) < 500:
            return first_sentence
        return vision[:500].rsplit(".", 1)[0].strip() + "."

    def _derive_values(self, vision: str) -> dict:
        vision_lower = vision.lower()
        values = {}

        value_indicators = {
            "innovation": ["innovate", "breakthrough", "novel", "cutting-edge", "disrupt"],
            "quality": ["quality", "excellence", "best", "premium", "reliable"],
            "speed": ["fast", "speed", "rapid", "quick", "agile", "velocity"],
            "customer_focus": ["customer", "user", "client", "customer-centric"],
            "transparency": ["transparent", "open", "honest", "clear"],
            "automation": ["automate", "autonomous", "ai-driven", "agent"],
            "scalability": ["scale", "scalable", "growth", "expand"],
            "security": ["secure", "privacy", "protect", "safe", "compliance"],
            "simplicity": ["simple", "easy", "intuitive", "seamless"],
            "collaboration": ["collaborate", "team", "together", "community"],
        }

        for value, indicators in value_indicators.items():
            matched = [i for i in indicators if i in vision_lower]
            if matched:
                values[value] = {
                    "name": value.replace("_", " ").title(),
                    "indicators": matched,
                }
        return values

    def _derive_principles(self, vision: str, nodes: dict | None) -> dict:
        return {
            "ai_first": {
                "title": "AI-First Development",
                "description": "Autonomous AI agents are the primary builders. Humans govern, agents execute.",
            },
            "infrastructure_abstraction": {
                "title": "Zero Infrastructure Knowledge",
                "description": "Users never touch VPS, Docker, Kubernetes, or terminals. The platform abstracts all infrastructure.",
            },
            "continuous_delivery": {
                "title": "Continuous Autonomous Delivery",
                "description": "Agents build, test, review, and deploy continuously with human approval gates at critical junctures.",
            },
            "memory_consistency": {
                "title": "Persistent Operational Memory",
                "description": "Every decision, action, and outcome is recorded in the company memory graph for consistent context.",
            },
            "governed_autonomy": {
                "title": "Governed Autonomy",
                "description": "Agents operate autonomously within constitutional boundaries. Humans approve high-risk decisions.",
            },
            "quality_by_default": {
                "title": "Quality by Default",
                "description": "AI self-review, QA validation, and sandbox deployment before any production change.",
            },
        }

    def _derive_governance(self, nodes: dict | None) -> dict:
        return {
            "decision_framework": {
                "autonomous_decisions": ["code generation", "testing", "bug fixes", "documentation", "monitoring"],
                "approval_required": ["deployments", "billing changes", "security policy", "new integrations", "architecture changes"],
                "approval_threshold": "medium_confidence_and_above",
            },
            "roles": {
                "founder": {"title": "Founder", "responsibilities": ["vision", "strategy", "final approval"]},
                "ceo_agent": {"title": "CEO Agent", "responsibilities": ["strategic planning", "resource allocation", "team orchestration"]},
                "cto_agent": {"title": "CTO Agent", "responsibilities": ["architecture", "technical decisions", "code review"]},
                "pm_agent": {"title": "PM Agent", "responsibilities": ["roadmap", "prioritization", "stakeholder alignment"]},
            },
            "escalation_path": ["agent_self_review", "peer_agent_review", "cto_review", "founder_review"],
        }

    def _derive_operational_rules(self, vision: str, nodes: dict | None) -> dict:
        return {
            "code_generation": "All code must be generated in isolated execution environments.",
            "testing": "Every change requires automated tests before review.",
            "deployment": "Production deployments require human approval.",
            "secrets": "Never expose API keys or secrets to agents or logs.",
            "monitoring": "All production services must have active monitoring and alerts.",
            "rollback": "Every deployment must support automated rollback.",
            "documentation": "All architectural decisions must be documented in the knowledge graph.",
        }

    def _generate_full_text(self, vision: str) -> str:
        return f"""# Company Constitution

## Preamble
This constitution governs the autonomous operation of this AI-native company. It is derived from the founder's vision and serves as the supreme operational framework for all agents and workflows.

## Mission
{self._derive_mission(vision)}

## Core Values
The company operates on the principles of AI-first development, governed autonomy, and continuous delivery. All agents are bound by these values in every decision and action.

## Governance
Agents operate autonomously within defined boundaries. High-risk decisions — including deployments, billing changes, and security policy modifications — require human approval. The escalation path ensures quality at every stage.

## Operational Rules
All agents must follow the operational rules defined herein. Violations trigger automatic review and correction workflows.
"""
