"""Converts a founder's vision into a structured knowledge graph."""

import uuid
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.company import KnowledgeGraph
from app.core.config import settings


class KnowledgeGraphService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate_from_vision(self, company_id: UUID, vision: str) -> KnowledgeGraph:
        analysis = self._analyze_vision(vision)

        kg = KnowledgeGraph(
            company_id=company_id,
            nodes=analysis["nodes"],
            edges=analysis["edges"],
            domains=analysis["domains"],
            capabilities=analysis["capabilities"],
        )
        self.db.add(kg)
        await self.db.flush()
        return kg

    def _analyze_vision(self, vision: str) -> dict:
        """Extract structured knowledge from vision text.

        In production, this calls the AI model (DeepSeek) to parse the vision.
        The structured extraction covers: domains, capabilities, entities, relationships.
        """
        domains = self._extract_domains(vision)
        capabilities = self._extract_capabilities(vision)
        nodes = self._build_nodes(domains, capabilities)
        edges = self._build_edges(nodes)

        return {
            "domains": domains,
            "capabilities": capabilities,
            "nodes": nodes,
            "edges": edges,
        }

    def _extract_domains(self, vision: str) -> dict:
        """Extract business/technical domains from vision text."""
        domain_keywords = {
            "product": ["product", "app", "platform", "saas", "software", "tool"],
            "ai_ml": ["ai", "ml", "machine learning", "model", "neural", "nlp", "llm"],
            "data": ["data", "analytics", "pipeline", "warehouse", "lake"],
            "infrastructure": ["cloud", "deploy", "infra", "kubernetes", "docker", "server"],
            "security": ["security", "auth", "encrypt", "compliance", "privacy"],
            "user_experience": ["ui", "ux", "design", "mobile", "web", "interface"],
            "business": ["revenue", "market", "customer", "sales", "growth", "billing"],
            "integration": ["api", "integration", "connect", "webhook", "sync"],
            "automation": ["automate", "workflow", "pipeline", "ci/cd", "orchestrate"],
        }

        vision_lower = vision.lower()
        matched_domains = {}
        for domain, keywords in domain_keywords.items():
            score = sum(1 for kw in keywords if kw in vision_lower)
            if score > 0:
                matched_domains[domain] = {
                    "name": domain.replace("_", " ").title(),
                    "relevance_score": min(score / len(keywords), 1.0),
                    "keywords_matched": [kw for kw in keywords if kw in vision_lower],
                }
        return matched_domains

    def _extract_capabilities(self, vision: str) -> dict:
        """Identify required capabilities from vision."""
        capability_patterns = {
            "web_application": ["web app", "website", "browser", "frontend", "react", "next.js"],
            "api_backend": ["api", "backend", "server", "endpoint", "rest", "graphql"],
            "database_management": ["database", "postgres", "sql", "nosql", "storage"],
            "ai_inference": ["model inference", "prediction", "generate", "classify"],
            "user_authentication": ["login", "signup", "auth", "user account", "profile"],
            "payment_processing": ["payment", "billing", "subscription", "stripe", "checkout"],
            "real_time": ["real-time", "websocket", "live", "streaming", "instant"],
            "mobile": ["mobile", "ios", "android", "app store", "native"],
            "analytics": ["analytics", "dashboard", "report", "metrics", "tracking"],
            "file_storage": ["upload", "file", "storage", "image", "document", "media"],
            "notification": ["email", "notification", "alert", "sms", "push"],
            "search": ["search", "index", "full-text", "elastic"],
        }

        vision_lower = vision.lower()
        capabilities = {}
        for cap, patterns in capability_patterns.items():
            matched = [p for p in patterns if p in vision_lower]
            if matched:
                capabilities[cap] = {
                    "name": cap.replace("_", " ").title(),
                    "required": True,
                    "patterns_matched": matched,
                }
        return capabilities

    def _build_nodes(self, domains: dict, capabilities: dict) -> dict:
        """Build knowledge graph nodes from domains and capabilities."""
        nodes = {}

        # Domain nodes
        for domain_key, domain_data in domains.items():
            node_id = f"domain:{domain_key}"
            nodes[node_id] = {
                "id": node_id,
                "type": "domain",
                "label": domain_data["name"],
                "properties": {"relevance": domain_data["relevance_score"]},
            }

        # Capability nodes
        for cap_key, cap_data in capabilities.items():
            node_id = f"capability:{cap_key}"
            nodes[node_id] = {
                "id": node_id,
                "type": "capability",
                "label": cap_data["name"],
                "properties": {"required": True},
            }

        # Agent role nodes (standard TACKTCIX agent structure)
        agent_roles = [
            ("ceo", "CEO", "Strategic direction and governance"),
            ("cto", "CTO", "Technical architecture and engineering leadership"),
            ("pm", "Product Manager", "Product vision and roadmap ownership"),
            ("frontend_dev", "Frontend Developer", "UI/UX implementation"),
            ("backend_dev", "Backend Developer", "API and server development"),
            ("ai_dev", "AI/ML Developer", "Model integration and AI features"),
            ("devops", "DevOps Engineer", "Infrastructure and deployment"),
            ("qa", "QA Engineer", "Testing and quality assurance"),
            ("designer", "UX Designer", "User experience and interface design"),
        ]
        for role_key, role_name, role_desc in agent_roles:
            node_id = f"agent:{role_key}"
            nodes[node_id] = {
                "id": node_id,
                "type": "agent_role",
                "label": role_name,
                "properties": {"description": role_desc},
            }

        return nodes

    def _build_edges(self, nodes: dict) -> dict:
        """Build edges connecting knowledge graph nodes."""
        edges = {}
        edge_idx = 0

        capability_to_domain = {
            "web_application": "product",
            "api_backend": "product",
            "database_management": "data",
            "ai_inference": "ai_ml",
            "user_authentication": "security",
            "payment_processing": "business",
            "real_time": "infrastructure",
            "analytics": "data",
            "file_storage": "infrastructure",
            "notification": "user_experience",
            "search": "data",
            "mobile": "product",
        }

        agent_to_domain = {
            "ceo": "business",
            "cto": "infrastructure",
            "pm": "product",
            "frontend_dev": "user_experience",
            "backend_dev": "product",
            "ai_dev": "ai_ml",
            "devops": "infrastructure",
            "qa": "product",
            "designer": "user_experience",
        }

        for cap_key, domain_key in capability_to_domain.items():
            cap_id = f"capability:{cap_key}"
            domain_id = f"domain:{domain_key}"
            if cap_id in nodes and domain_id in nodes:
                edges[str(edge_idx)] = {
                    "source": cap_id, "target": domain_id,
                    "type": "belongs_to", "label": "belongs to",
                }
                edge_idx += 1

        for agent_key, domain_key in agent_to_domain.items():
            agent_id = f"agent:{agent_key}"
            domain_id = f"domain:{domain_key}"
            if agent_id in nodes and domain_id in nodes:
                edges[str(edge_idx)] = {
                    "source": agent_id, "target": domain_id,
                    "type": "specializes_in", "label": "specializes in",
                }
                edge_idx += 1

        return edges
