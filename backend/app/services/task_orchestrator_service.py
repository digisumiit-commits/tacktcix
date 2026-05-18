"""Task orchestrator — routes sub-tasks to the best-fit agent.

Routing uses a weighted scoring model:
  - Capability matching (60 %) — does the agent have the required domain skills?
  - Load balancing   (25 %) — how much capacity does the agent have free?
  - Cost optimization (15 %) — what is the most cost-effective choice?

All scores are normalised to [0.0, 1.0]; the agent with the highest total
score is selected.  If multiple agents tie, the one with the lowest current
load wins.

Cross-agent routing
-------------------
Single-task routing routes one task to one agent.  Cross-agent routing
(``batch_route_tasks``) routes *multiple* sub-tasks across the available
agents in a single coordinated pass, using greedy load-aware assignment so
that earlier assignments don't starve later ones.
"""

import logging
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent import Agent, AgentRouteRequest, AgentRouteResult
from app.services.agent_registry_service import AgentRegistryService
from app.services.event_service import EventService, EventTypes

logger = logging.getLogger(__name__)

# ── Routing weights ──────────────────────────────────────────────────────────
W_CAPABILITY = 0.60
W_LOAD = 0.25
W_COST = 0.15

# Agents in these statuses are considered eligible for routing.
_HEALTHY_STATUSES = frozenset({"idle", "busy"})


class TaskOrchestrator:
    """Routes sub-tasks to the most appropriate agent."""

    def __init__(self, db: AsyncSession, events: EventService | None = None):
        self.db = db
        self.events = events
        self.registry = AgentRegistryService(db, events)

    # ── Candidate filtering ────────────────────────────────────────────────────

    async def _get_healthy_candidates(self, company_id: UUID,
                                       role: str | None = None) -> list[Agent]:
        """Return candidates whose status is *not* offline."""
        candidates = await self.registry.list_agents(company_id, role=role, status=None)

        offline = [a for a in candidates if a.status == "offline"]
        if offline:
            logger.warning(
                "Excluding %d offline agent(s) for company %s: %s",
                len(offline), company_id,
                [(a.id, a.role, a.name) for a in offline],
            )
        return [a for a in candidates if a.status in _HEALTHY_STATUSES]

    # ── Public API ──────────────────────────────────────────────────────────

    async def route_task(self, company_id: UUID, request: AgentRouteRequest) -> AgentRouteResult:
        """Route a single sub-task to the best-fit agent.

        Returns the selected agent with a score breakdown.
        Raises ``RuntimeError`` if no eligible agent is found.
        """
        candidates = await self._get_healthy_candidates(company_id)
        result = await self._select_best(request, candidates)

        if self.events:
            await self.events.agent_action(
                company_id=company_id,
                agent_name=result.agent_name,
                action=f"Task routed: {request.task_title}",
                source_id=str(result.agent_id),
                description=f"Routed to {result.agent_role} with score {result.score:.2f}",
                metadata={
                    "agent_role": result.agent_role,
                    "score": result.score,
                    "breakdown": result.breakdown,
                },
            )
        return result

    async def route_task_to_role(self, company_id: UUID, request: AgentRouteRequest,
                                 preferred_role: str) -> AgentRouteResult:
        """Route a task, preferring agents of a specific role.

        If the preferred role has available agents, the best one is selected.
        Otherwise falls back to the general routing algorithm so work never
        stalls.
        """
        candidates = await self._get_healthy_candidates(company_id, role=preferred_role)
        if not candidates:
            logger.info("No %s agents available for company %s — falling back to general routing",
                        preferred_role, company_id)
            return await self.route_task(company_id, request)

        return await self._select_best(request, candidates)

    async def route_workflow_step(self, company_id: UUID,
                                  step: dict, available_agents: dict[str, bool]) -> AgentRouteResult | None:
        """Route a single workflow step to an agent.

        ``step`` is a workflow-step dict with keys ``action``, ``agent``.
        ``available_agents`` maps role → bool showing which roles are present.
        """
        preferred_role: str = step.get("agent", "backend_dev")
        step_action: str = step.get("action", "unknown")

        # Determine required domains from the action name
        domains = self._domains_for_action(step_action, preferred_role)

        req = AgentRouteRequest(
            task_title=step_action,
            task_description=f"Workflow step: {step_action}",
            required_domains=domains,
            estimated_complexity=1.0,
            priority="medium",
        )

        # Prefer the step's designated agent role
        return await self.route_task_to_role(company_id, req, preferred_role)

    async def batch_route_tasks(self, company_id: UUID,
                                 requests: list[AgentRouteRequest]) -> "BatchRouteResponse":
        """Route multiple sub-tasks across agents in a coordinated pass.

        Uses greedy coordinated assignment:
          1. Fetch healthy candidates once.
          2. Sort sub-tasks by priority (high -> medium -> low).
          3. For each sub-task, score every candidate considering *already-
             assigned* virtual load so earlier assignments inform later ones.
          4. Assign the sub-task to the best-scoring agent, bump its virtual
             load, and move on.

        Returns ``BatchRouteResponse`` with ``assignments`` and ``unassigned``.
        """
        from app.models.agent import BatchRouteResponse

        candidates = await self._get_healthy_candidates(company_id)
        if not candidates:
            logger.warning("No healthy agents for company %s — all %d tasks unassigned",
                           company_id, len(requests))
            return BatchRouteResponse(
                assignments=[],
                unassigned=[r.task_title for r in requests],
            )

        # Priority sort: high first, then medium, then low
        _PRIORITY_SORT = {"high": 0, "medium": 1, "low": 2}
        sorted_requests = sorted(
            requests,
            key=lambda r: _PRIORITY_SORT.get(r.priority, 1),
        )

        # Virtual load tracker — mirrors the load we *will* have assigned.
        virtual_load: dict[UUID, int] = {a.id: a.current_load for a in candidates}

        assignments: list[AgentRouteResult] = []
        unassigned: list[str] = []

        for req in sorted_requests:
            best = await self._select_best_with_load(
                req, candidates, virtual_load,
            )
            if best is None:
                unassigned.append(req.task_title)
                continue

            best.task_title = req.task_title
            virtual_load[best.agent_id] += 1
            assignments.append(best)

        if self.events:
            await self.events.agent_action(
                company_id=company_id,
                agent_name="orchestrator",
                action=f"Batch routed {len(assignments)} tasks",
                source_id="batch_route",
                description=f"{len(assignments)} assigned, {len(unassigned)} unassigned",
                metadata={
                    "total": len(requests),
                    "assigned": len(assignments),
                    "unassigned": len(unassigned),
                    "unassigned_titles": unassigned,
                },
            )

        return BatchRouteResponse(assignments=assignments, unassigned=unassigned)

    async def assign_subtask(self, task_id: UUID, agent_id: UUID, task_title: str | None = None) -> None:
        """Record a task assignment — increments the agent's load counter."""
        await self.registry.assign_task(agent_id, task_title)

    async def complete_subtask(self, task_id: UUID, agent_id: UUID, task_title: str | None = None) -> None:
        """Record a task completion — decrements the agent's load counter."""
        await self.registry.complete_task(agent_id, task_title)

    async def assign_tasks(
        self,
        company_id: UUID,
        tasks: list,
        *,
        batch: bool = True,
    ) -> list[dict]:
        """Route and assign a list of Task model instances to the best-fit agents.

        Each task's ``assignee_role`` is used as the preferred role; if the
        task has ``metadata.required_domains`` those are passed to the routing
        engine.  After routing the selected agent's load is incremented and
        the task's ``assignee_agent_id`` is set.

        Parameters
        ----------
        company_id
            The company these tasks belong to.
        tasks
            List of Task ORM instances (must have ``id``, ``title``,
            ``assignee_role``, ``priority``, ``metadata`` attributes).
        batch
            When True (default) uses ``batch_route_tasks`` for coordinated
            greedy load-aware assignment.  When False uses individual
            ``route_task`` calls.

        Returns
        -------
        list[dict]
            One entry per task: ``{"task_id", "task_title", "agent_id",
            "agent_role", "agent_name", "score"}``.  Unroutable tasks have
            ``agent_id = None`` and ``score = 0``.
        """
        from app.models.company import Task as TaskModel

        results: list[dict] = []

        if batch:
            # Build route requests from tasks
            requests = []
            task_map: dict[str, TaskModel] = {}
            for t in tasks:
                domains = []
                if t.meta and "required_domains" in t.meta:
                    domains = t.meta["required_domains"]
                requests.append(AgentRouteRequest(
                    task_title=t.title,
                    task_description=t.description or "",
                    required_domains=domains,
                    estimated_complexity=1.0,
                    priority=t.priority or "medium",
                ))
                task_map[t.title] = t

            if not requests:
                return results

            batch_result = await self.batch_route_tasks(company_id, requests)

            for assignment in batch_result.assignments:
                task_obj = task_map.get(assignment.task_title)
                if task_obj is not None:
                    task_obj.assignee_agent_id = assignment.agent_id
                    results.append({
                        "task_id": str(task_obj.id),
                        "task_title": task_obj.title,
                        "agent_id": str(assignment.agent_id),
                        "agent_role": assignment.agent_role,
                        "agent_name": assignment.agent_name,
                        "score": assignment.score,
                    })

            for title in batch_result.unassigned:
                task_obj = task_map.get(title)
                if task_obj is not None:
                    results.append({
                        "task_id": str(task_obj.id),
                        "task_title": task_obj.title,
                        "agent_id": None,
                        "agent_role": None,
                        "agent_name": None,
                        "score": 0,
                    })
        else:
            for t in tasks:
                domains = []
                if t.meta and "required_domains" in t.meta:
                    domains = t.meta["required_domains"]
                req = AgentRouteRequest(
                    task_title=t.title,
                    task_description=t.description or "",
                    required_domains=domains,
                    estimated_complexity=1.0,
                    priority=t.priority or "medium",
                )
                try:
                    result = await self.route_task_to_role(
                        company_id, req, t.assignee_role or "backend_dev",
                    )
                    t.assignee_agent_id = result.agent_id
                    results.append({
                        "task_id": str(t.id),
                        "task_title": t.title,
                        "agent_id": str(result.agent_id),
                        "agent_role": result.agent_role,
                        "agent_name": result.agent_name,
                        "score": result.score,
                    })
                except RuntimeError:
                    results.append({
                        "task_id": str(t.id),
                        "task_title": t.title,
                        "agent_id": None,
                        "agent_role": None,
                        "agent_name": None,
                        "score": 0,
                    })

        await self.db.flush()
        return results

    # ── Selection ──────────────────────────────────────────────────────────────

    async def _select_best(self, request: AgentRouteRequest,
                           candidates: list[Agent]) -> AgentRouteResult:
        """Score every candidate agent and return the best match.

        Raises ``RuntimeError`` if *no* candidates are provided — the caller
        should have already applied health/role filtering.
        """
        if not candidates:
            raise RuntimeError("No eligible agents available for routing")

        scored = self._score_all(candidates, request)
        # Descending by total score, then by load (lower is better) as tie-break
        scored.sort(key=lambda t: (-t[0], t[2].current_load))

        best_total, best_breakdown, best_agent = scored[0]
        reason = self._build_reason(best_agent, request, best_breakdown)

        return AgentRouteResult(
            agent_id=best_agent.id,
            agent_role=best_agent.role,
            agent_name=best_agent.name,
            score=round(best_total, 4),
            breakdown=best_breakdown,
            reason=reason,
        )

    async def _select_best_with_load(
        self,
        request: AgentRouteRequest,
        candidates: list[Agent],
        virtual_load: dict[UUID, int],
    ) -> AgentRouteResult | None:
        """Score candidates using *virtual* load (coordinated batch view).

        Returns ``None`` when every candidate is saturated (virtual load >=
        max_concurrent_tasks for all).
        """
        scored: list[tuple[float, dict[str, float], Agent]] = []
        for agent in candidates:
            effective_load = virtual_load.get(agent.id, agent.current_load)
            # Short-circuit: completely saturated -> skip
            if agent.max_concurrent_tasks > 0 and effective_load >= agent.max_concurrent_tasks:
                continue

            # Temporarily patch current_load for scoring, then restore.
            original_load = agent.current_load
            agent.current_load = effective_load
            try:
                cap_score = self._score_capability(agent, request.required_domains)
                load_score = self._score_load(agent)
                cost_score = self._score_cost(agent, request)
            finally:
                agent.current_load = original_load

            breakdown = {
                "capability": round(cap_score, 4),
                "load": round(load_score, 4),
                "cost": round(cost_score, 4),
            }

            total = (
                W_CAPABILITY * cap_score +
                W_LOAD * load_score +
                W_COST * cost_score
            )
            scored.append((total, breakdown, agent))

        if not scored:
            return None

        # Tie-break by virtual load (lower is better)
        scored.sort(key=lambda t: (-t[0], virtual_load.get(t[2].id, t[2].current_load)))
        best_total, best_breakdown, best_agent = scored[0]
        reason = self._build_reason(best_agent, request, best_breakdown)

        return AgentRouteResult(
            agent_id=best_agent.id,
            agent_role=best_agent.role,
            agent_name=best_agent.name,
            score=round(best_total, 4),
            breakdown=best_breakdown,
            reason=reason,
        )

    # ── Scoring engine ──────────────────────────────────────────────────────

    def _score_all(self, candidates: list[Agent],
                   request: AgentRouteRequest) -> list[tuple[float, dict[str, float], Agent]]:
        """Score every candidate and return (total, breakdown, agent) tuples."""
        scored: list[tuple[float, dict[str, float], Agent]] = []
        for agent in candidates:
            breakdown = {}
            cap_score = self._score_capability(agent, request.required_domains)
            load_score = self._score_load(agent)
            cost_score = self._score_cost(agent, request)

            breakdown["capability"] = round(cap_score, 4)
            breakdown["load"] = round(load_score, 4)
            breakdown["cost"] = round(cost_score, 4)

            total = (
                W_CAPABILITY * cap_score +
                W_LOAD * load_score +
                W_COST * cost_score
            )
            scored.append((total, breakdown, agent))
        return scored

    def _score_capability(self, agent: Agent, required_domains: list[str]) -> float:
        """Capability score: how well does this agent cover the required domains?

        Returns a value in [0.0, 1.0].
        """
        if not required_domains:
            return 0.8  # no specific requirement — assume moderate fit

        caps = agent.capabilities or {}
        if not caps:
            return 0.3  # no capability data — conservative

        total = 0.0
        for domain in required_domains:
            # Exact domain match
            prof = caps.get(domain, 0.0)
            if prof == 0.0:
                # Partial-keyword fallback: check if any capability key
                # contains the domain as a substring or vice versa.
                for cap_key, cap_val in caps.items():
                    if domain in cap_key or cap_key in domain:
                        prof = max(prof, cap_val * 0.8)
            total += prof

        avg = total / len(required_domains)
        return min(avg, 1.0)

    def _score_load(self, agent: Agent) -> float:
        """Load score: how much free capacity does this agent have?

        1.0 = completely free, 0.0 = fully loaded (or over capacity).
        """
        if agent.max_concurrent_tasks <= 0:
            return 0.0
        ratio = agent.current_load / agent.max_concurrent_tasks
        if ratio >= 1.0:
            return 0.0
        return 1.0 - ratio

    def _score_cost(self, agent: Agent, request: AgentRouteRequest) -> float:
        """Cost score: cheaper agents score higher.

        Normalised against an assumed max-cost baseline of 5.0.  A free
        agent (cost 0) gets 1.0; anything >= 5.0 gets near 0.
        """
        max_cost = 5.0
        effective = agent.cost_per_task * (request.estimated_complexity ** 0.5)
        return max(0.0, 1.0 - (effective / max_cost))

    # ── Helpers ─────────────────────────────────────────────────────────────

    @staticmethod
    def _domains_for_action(action: str, role: str) -> list[str]:
        """Map a workflow action name to the required domain keywords."""
        mapping: dict[str, list[str]] = {
            "scan_pending_tasks": ["planning", "analytics"],
            "prioritize_by_dependencies": ["planning", "product"],
            "assign_to_agents": ["governance", "leadership"],
            "execute_tasks": ["backend", "frontend"],
            "report_status": ["communication", "analytics"],
            "self_review": ["code_review", "testing"],
            "peer_review": ["code_review", "communication"],
            "cto_review": ["architecture", "code_review"],
            "sandbox_deploy": ["infrastructure", "ci_cd"],
            "qa_validation": ["testing", "automation"],
            "request_approval": ["governance", "communication"],
            "production_deploy": ["infrastructure", "cloud"],
            "conduct_onboarding_interview": ["product", "communication"],
            "analyze_vision": ["ai_ml", "nlp"],
            "generate_knowledge_graph": ["ai_ml", "data_science"],
            "generate_constitution": ["strategy", "governance"],
            "generate_roadmap": ["planning", "product"],
            "generate_architecture": ["architecture", "backend"],
            "generate_initial_tasks": ["planning", "product"],
            "present_dashboard": ["communication", "ui"],
            # ── Marketing actions ──
            "generate_content": ["content_creation", "seo"],
            "create_campaign": ["campaign_management", "brand_strategy"],
            "analyze_campaign_performance": ["analytics", "campaign_management"],
            "create_social_media_post": ["content_creation", "social_media"],
            "create_email_campaign": ["email_marketing", "content_creation"],
            "analyze_market_trends": ["market_research", "analytics"],
            "track_campaign_metrics": ["analytics", "campaign_management"],
        }
        return mapping.get(action, [role])

    @staticmethod
    def _build_reason(agent: Agent, request: AgentRouteRequest,
                      breakdown: dict[str, float]) -> str:
        parts = []
        if breakdown.get("capability", 0) >= 0.7:
            parts.append("strong capability match")
        elif breakdown.get("capability", 0) >= 0.4:
            parts.append("moderate capability match")
        else:
            parts.append("weak capability match")

        if breakdown.get("load", 0) >= 0.7:
            parts.append("low load")
        elif breakdown.get("load", 0) >= 0.4:
            parts.append("moderate load")

        if breakdown.get("cost", 0) >= 0.7:
            parts.append("cost-effective")

        return f"Selected {agent.role} ({agent.name}): {', '.join(parts)}"
