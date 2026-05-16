"""Generates an architecture plan from vision and knowledge graph."""

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.company import ArchitecturePlan


class ArchitectureService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate(self, company_id: UUID, vision: str, knowledge_nodes: dict | None,
                       selected_models: dict | None) -> ArchitecturePlan:
        tech_stack = self._recommend_tech_stack(vision, knowledge_nodes, selected_models)
        system_design = self._design_system(vision, knowledge_nodes)
        data_models = self._design_data_models(vision)
        api_spec = self._design_api(vision)
        infrastructure = self._design_infrastructure(vision)

        plan = ArchitecturePlan(
            company_id=company_id,
            tech_stack=tech_stack,
            system_design=system_design,
            data_models=data_models,
            api_spec=api_spec,
            infrastructure=infrastructure,
            full_text=self._generate_full_text(tech_stack, system_design, data_models, api_spec, infrastructure),
        )
        self.db.add(plan)
        await self.db.flush()
        return plan

    def _recommend_tech_stack(self, vision: str, nodes: dict | None, models: dict | None) -> dict:
        vision_lower = vision.lower()

        frontend = "next.js"
        if any(w in vision_lower for w in ["mobile", "ios", "android", "react native"]):
            frontend = "next.js + react native"

        backend = "fastapi (python)"
        if any(w in vision_lower for w in ["real-time", "websocket", "streaming"]):
            backend = "fastapi (python) + websockets"

        return {
            "frontend": {
                "framework": frontend,
                "language": "typescript",
                "styling": "tailwind css",
                "state_management": "react context + server components",
                "testing": "vitest + playwright",
            },
            "backend": {
                "framework": backend,
                "language": "python 3.12+",
                "api_style": "rest + websocket",
                "testing": "pytest",
            },
            "database": {
                "primary": "postgresql 16",
                "vector": "qdrant",
                "graph": "neo4j 5",
                "cache": "redis 7",
            },
            "ai_models": models if models else {"default": "deepseek-chat"},
            "infrastructure": {
                "containers": "docker",
                "orchestration": "kubernetes (managed)",
                "ci_cd": "github actions",
                "hosting": "vercel (frontend) + railway (backend)",
                "monitoring": "grafana + langfuse + opentelemetry",
            },
            "browser_automation": {
                "framework": "playwright",
                "infrastructure": "browserless",
                "ai_enhancement": "stagehand",
            },
        }

    def _design_system(self, vision: str, nodes: dict | None) -> dict:
        return {
            "layers": [
                {
                    "name": "Presentation Layer",
                    "components": ["Next.js SSR/SSG", "React Server Components", "Tailwind CSS", "Dashboard UI"],
                    "responsibility": "User interface and experience",
                },
                {
                    "name": "API Gateway Layer",
                    "components": ["FastAPI REST", "WebSocket handlers", "Authentication middleware", "Rate limiting"],
                    "responsibility": "Request routing, auth, rate limiting",
                },
                {
                    "name": "Service Layer",
                    "components": ["Onboarding Service", "Knowledge Graph Service", "Agent Orchestrator", "Task Engine", "Deployment Service"],
                    "responsibility": "Business logic and orchestration",
                },
                {
                    "name": "AI Layer",
                    "components": ["Model Router (LiteLLM)", "Prompt Manager", "Vision Analyzer", "Code Generator"],
                    "responsibility": "AI model management and inference",
                },
                {
                    "name": "Memory Layer",
                    "components": ["PostgreSQL (relational)", "Qdrant (vector)", "Neo4j (graph)", "Redis (cache)"],
                    "responsibility": "Multi-modal persistent memory",
                },
                {
                    "name": "Execution Layer",
                    "components": ["Docker containers", "Browser sessions", "Code sandboxes", "Deployment workers"],
                    "responsibility": "Isolated execution environments",
                },
                {
                    "name": "Infrastructure Layer",
                    "components": ["Kubernetes", "GitHub Actions", "Vercel", "Railway", "Grafana"],
                    "responsibility": "Deployment, scaling, monitoring",
                },
            ],
            "communication_patterns": {
                "sync": "REST API for request-response",
                "async": "Redis queues for task orchestration",
                "realtime": "WebSocket for live updates and agent heartbeats",
                "events": "Internal event bus for cross-service communication",
            },
        }

    def _design_data_models(self, vision: str) -> dict:
        return {
            "core_entities": [
                {"name": "Company", "description": "Top-level tenant entity with configuration and state"},
                {"name": "User", "description": "Human collaborator with role-based access"},
                {"name": "Agent", "description": "AI agent with role, capabilities, and personality"},
                {"name": "Task", "description": "Work unit with priority, dependencies, and approval state"},
                {"name": "Workflow", "description": "Automated multi-step process with triggers and agents"},
                {"name": "Memory", "description": "Multi-layer memory record (founder, project, agent, episodic)"},
                {"name": "Deployment", "description": "Code deployment with version, environment, and status"},
                {"name": "KnowledgeNode", "description": "Graph node in company knowledge graph"},
                {"name": "BillingRecord", "description": "Usage tracking and billing event"},
            ],
            "database_per_concern": {
                "relational": "PostgreSQL — users, companies, tasks, workflows, billing",
                "vector": "Qdrant — semantic memory, knowledge embeddings, search",
                "graph": "Neo4j — knowledge graph, agent relationships, dependencies",
                "cache": "Redis — session state, task queues, real-time data",
            },
        }

    def _design_api(self, vision: str) -> dict:
        return {
            "rest_endpoints": {
                "/api/v1/auth": ["POST /signup", "POST /login", "POST /logout"],
                "/api/v1/companies": ["POST /", "GET /{id}", "PATCH /{id}", "GET /{id}/dashboard"],
                "/api/v1/onboarding": ["POST /start", "POST /{id}/step", "POST /{id}/vision", "POST /{id}/process"],
                "/api/v1/tasks": ["GET /", "POST /", "PATCH /{id}", "POST /{id}/approve"],
                "/api/v1/agents": ["GET /", "GET /{id}", "PATCH /{id}/config"],
                "/api/v1/memory": ["GET /search", "POST /", "GET /graph"],
                "/api/v1/deployments": ["POST /", "GET /{id}", "POST /{id}/rollback"],
                "/api/v1/billing": ["GET /usage", "GET /invoices", "POST /credits/add"],
            },
            "websocket_channels": {
                "/ws/agent-heartbeat": "Agent status and health updates",
                "/ws/task-updates": "Real-time task status changes",
                "/ws/deployment-logs": "Live deployment log streaming",
            },
        }

    def _design_infrastructure(self, vision: str) -> dict:
        return {
            "environments": [
                {"name": "development", "purpose": "Local agent development and testing"},
                {"name": "staging", "purpose": "Pre-production validation and QA"},
                {"name": "production", "purpose": "Live customer-facing deployment"},
            ],
            "scaling": {
                "frontend": "Vercel auto-scaling",
                "backend": "Railway horizontal scaling",
                "database": "Managed PostgreSQL with read replicas",
                "cache": "Redis cluster",
            },
            "security": {
                "secrets": "Encrypted at rest, never exposed to agents",
                "execution": "Isolated Docker containers per agent run",
                "network": "VPC with least-privilege access",
                "auth": "JWT with short-lived tokens, refresh rotation",
            },
        }

    def _generate_full_text(self, tech_stack: dict, system_design: dict,
                            data_models: dict, api_spec: dict, infrastructure: dict) -> str:
        return f"""# Architecture Plan

## Technology Stack
- **Frontend**: {tech_stack['frontend']['framework']} ({tech_stack['frontend']['language']})
- **Backend**: {tech_stack['backend']['framework']}
- **Database**: {tech_stack['database']['primary']} + Qdrant (vector) + Neo4j (graph)
- **Infrastructure**: Docker, Kubernetes, Vercel, Railway
- **AI Models**: {', '.join(tech_stack['ai_models'].values()) if tech_stack['ai_models'] else 'DeepSeek Chat'}

## System Design
A 7-layer architecture: Presentation → API Gateway → Services → AI → Memory → Execution → Infrastructure.
Communication via REST (sync), Redis queues (async), WebSocket (realtime), and internal events.

## Data Architecture
PostgreSQL for relational data, Qdrant for semantic memory and search, Neo4j for the knowledge graph, and Redis for caching and queues.

## API Design
RESTful API at /api/v1/ with WebSocket channels for real-time agent heartbeats, task updates, and deployment logs.

## Infrastructure
Three environments (dev, staging, production) with auto-scaling, isolated execution containers, and encrypted secrets management.
"""
