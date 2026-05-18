"""Tests for the TaskOrchestrator routing engine.

These tests validate the weighted scoring model directly by instantiating
the orchestrator and testing its private scoring methods, as well as the
end-to-end routing flow with mocked agent lists.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.agent import Agent, AgentRouteRequest, AgentRouteResult
from app.services.task_orchestrator_service import (
    TaskOrchestrator,
    W_CAPABILITY,
    W_LOAD,
    W_COST,
)
from app.services.agent_registry_service import ROLE_CAPABILITIES


# ── Helpers ──────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_db():
    return AsyncMock()


@pytest.fixture
def orchestrator(mock_db):
    return TaskOrchestrator(mock_db)


def make_agent(role="backend_dev", capabilities=None, cost=1.0,
               max_tasks=3, load=0, status="idle"):
    return Agent(
        id=uuid.uuid4(),
        company_id=uuid.uuid4(),
        role=role,
        name=f"{role} Agent",
        description=f"Test {role} agent",
        status=status,
        capabilities=capabilities or dict(ROLE_CAPABILITIES.get(role, {})),
        cost_per_task=cost,
        max_concurrent_tasks=max_tasks,
        current_load=load,
    )


# ── Scoring: Capability ──────────────────────────────────────────────────────

class TestCapabilityScore:
    def test_exact_domain_match(self, orchestrator):
        agent = make_agent("frontend_dev", capabilities={"frontend": 1.0, "ui": 0.9})
        score = orchestrator._score_capability(agent, ["frontend", "ui"])
        # (1.0 + 0.9) / 2 = 0.95
        assert score == pytest.approx(0.95, abs=1e-4)

    def test_no_required_domains_returns_default(self, orchestrator):
        agent = make_agent("backend_dev")
        score = orchestrator._score_capability(agent, [])
        assert score == 0.8

    def test_unknown_domain_scores_low(self, orchestrator):
        agent = make_agent("ceo", capabilities={"business": 1.0, "strategy": 0.9})
        score = orchestrator._score_capability(agent, ["quantum_physics"])
        # The domain "quantum_physics" has no match. Fallback substring check:
        # "quantum_physics" is not in any capability key and vice versa.
        # → 0.0
        assert score == 0.0

    def test_partial_keyword_fallback(self, orchestrator):
        agent = make_agent("devops", capabilities={"infrastructure": 1.0, "ci_cd": 0.9})
        score = orchestrator._score_capability(agent, ["ci"])
        # "ci" is a substring of "ci_cd" → fallback applies 0.9 * 0.8 = 0.72
        assert score == pytest.approx(0.72, abs=1e-4)

    def test_empty_capabilities_returns_conservative(self, orchestrator):
        agent = make_agent("generic", capabilities={})
        score = orchestrator._score_capability(agent, ["backend"])
        assert score == 0.3


# ── Scoring: Load ────────────────────────────────────────────────────────────

class TestLoadScore:
    def test_completely_free(self, orchestrator):
        agent = make_agent(load=0, max_tasks=5)
        assert orchestrator._score_load(agent) == 1.0

    def test_half_loaded(self, orchestrator):
        agent = make_agent(load=2, max_tasks=4)
        assert orchestrator._score_load(agent) == 0.5

    def test_fully_loaded(self, orchestrator):
        agent = make_agent(load=3, max_tasks=3)
        assert orchestrator._score_load(agent) == 0.0

    def test_over_capacity(self, orchestrator):
        agent = make_agent(load=5, max_tasks=3)
        assert orchestrator._score_load(agent) == 0.0

    def test_zero_max_tasks(self, orchestrator):
        agent = make_agent(load=0, max_tasks=0)
        assert orchestrator._score_load(agent) == 0.0


# ── Scoring: Cost ────────────────────────────────────────────────────────────

class TestCostScore:
    def test_free_agent(self, orchestrator):
        agent = make_agent(cost=0.0)
        req = AgentRouteRequest(task_title="test")
        assert orchestrator._score_cost(agent, req) == 1.0

    def test_expensive_agent(self, orchestrator):
        agent = make_agent(cost=5.0)
        req = AgentRouteRequest(task_title="test")
        assert orchestrator._score_cost(agent, req) == pytest.approx(0.0, abs=1e-4)

    def test_medium_cost(self, orchestrator):
        agent = make_agent(cost=2.0)
        req = AgentRouteRequest(task_title="test", estimated_complexity=1.0)
        score = orchestrator._score_cost(agent, req)
        assert 0.5 < score < 0.7  # 1 - (2.0/5.0) = 0.6

    def test_complexity_scales_cost_up(self, orchestrator):
        agent = make_agent(cost=1.0)
        simple = AgentRouteRequest(task_title="test", estimated_complexity=0.5)
        complex = AgentRouteRequest(task_title="test", estimated_complexity=4.0)
        assert orchestrator._score_cost(agent, complex) < orchestrator._score_cost(agent, simple)


# ── Full routing decision ────────────────────────────────────────────────────

class TestSelectBest:
    async def test_selects_highest_scoring_agent(self, orchestrator):
        req = AgentRouteRequest(
            task_title="Build login page",
            required_domains=["frontend", "ui"],
            estimated_complexity=1.0,
        )
        frontend = make_agent("frontend_dev", capabilities={"frontend": 1.0, "ui": 1.0}, cost=1.0, load=0)
        backend = make_agent("backend_dev", capabilities={"backend": 1.0, "api": 1.0}, cost=1.0, load=0)

        result = await orchestrator._select_best(req, [frontend, backend])
        assert result.agent_role == "frontend_dev"

    async def test_load_tiebreak_lower_load_wins(self, orchestrator):
        """When two agents have identical scores, pick the one with lower load."""
        req = AgentRouteRequest(
            task_title="Generic task",
            required_domains=["backend"],
            estimated_complexity=1.0,
        )
        # Two identical backend agents, different loads
        agent_a = make_agent("backend_dev", load=0)
        agent_b = make_agent("backend_dev", load=3)

        result = await orchestrator._select_best(req, [agent_a, agent_b])
        assert result.agent_id == agent_a.id

    async def test_raises_when_no_candidates(self, orchestrator):
        req = AgentRouteRequest(task_title="task")
        with pytest.raises(RuntimeError, match="No eligible agents"):
            await orchestrator._select_best(req, [])

    async def test_busy_agent_gets_penalized(self, orchestrator):
        """A loaded agent should score lower on load than a free one."""
        req = AgentRouteRequest(
            task_title="API endpoint",
            required_domains=["backend", "api"],
            estimated_complexity=1.0,
        )
        free = make_agent("backend_dev", load=0, max_tasks=3)
        busy = make_agent("backend_dev", load=3, max_tasks=3)

        result = await orchestrator._select_best(req, [free, busy])
        assert result.agent_id == free.id

    async def test_cheaper_agent_preferred_when_same_capability(self, orchestrator):
        """Given equal capability, pick the cheaper agent."""
        req = AgentRouteRequest(
            task_title="Write tests",
            required_domains=["testing"],
            estimated_complexity=1.0,
        )
        cheap = make_agent("qa", capabilities={"testing": 1.0, "automation": 0.9}, cost=0.8, load=0)
        expensive = make_agent("cto", capabilities={"testing": 1.0, "automation": 0.9}, cost=2.5, load=0)

        result = await orchestrator._select_best(req, [cheap, expensive])
        assert result.agent_id == cheap.id

    async def test_returns_breakdown(self, orchestrator):
        req = AgentRouteRequest(
            task_title="Deploy to prod",
            required_domains=["infrastructure", "ci_cd"],
        )
        agent = make_agent("devops", load=0)

        result = await orchestrator._select_best(req, [agent])
        assert isinstance(result.breakdown, dict)
        assert "capability" in result.breakdown
        assert "load" in result.breakdown
        assert "cost" in result.breakdown
        assert result.score > 0


# ── Route-to-role fallback ──────────────────────────────────────────────────

class TestRouteToRole:
    async def test_prefers_requested_role(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        req = AgentRouteRequest(
            task_title="Review code",
            required_domains=["code_review"],
        )

        # Mock registry.list_agents to return only CTO when filtering by role
        cto = make_agent("cto", capabilities={"code_review": 0.9})

        # orchestrator.registry is already created in __init__
        orchestrator.registry.list_agents = AsyncMock(return_value=[cto])

        result = await orchestrator.route_task_to_role(cid, req, "cto")
        assert result.agent_role == "cto"

    async def test_falls_back_when_preferred_role_unavailable(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        req = AgentRouteRequest(
            task_title="Build frontend",
            required_domains=["frontend"],
        )

        orchestrator.registry.list_agents = AsyncMock(side_effect=[
            [],  # frontend_dev → empty
            [make_agent("backend_dev", capabilities={"frontend": 0.3})],  # fallback → any
        ])

        result = await orchestrator.route_task_to_role(cid, req, "frontend_dev")
        assert result is not None


# ── Task lifecycle ───────────────────────────────────────────────────────────

class TestTaskLifecycle:
    async def test_assign_subtask_increments_load(self, orchestrator, mock_db):
        orchestrator.registry.assign_task = AsyncMock(return_value=make_agent())
        await orchestrator.assign_subtask(uuid.uuid4(), uuid.uuid4())
        orchestrator.registry.assign_task.assert_awaited_once()

    async def test_complete_subtask_decrements_load(self, orchestrator, mock_db):
        orchestrator.registry.complete_task = AsyncMock(return_value=make_agent())
        await orchestrator.complete_subtask(uuid.uuid4(), uuid.uuid4())
        orchestrator.registry.complete_task.assert_awaited_once()


# ── Weighting sanity ─────────────────────────────────────────────────────────

class TestWeights:
    """Verify the routing weights are internally consistent and sum to 1.0."""

    def test_weights_sum_to_one(self):
        total = W_CAPABILITY + W_LOAD + W_COST
        assert total == pytest.approx(1.0)

    def test_capability_is_dominant(self):
        assert W_CAPABILITY > W_LOAD + W_COST


# ── Health-aware filtering ───────────────────────────────────────────────────

class TestHealthFiltering:
    """Offline agents should be excluded from routing candidates."""

    async def test_excludes_offline_agents(self, orchestrator, mock_db):
        """route_task should skip offline agents."""
        cid = uuid.uuid4()
        req = AgentRouteRequest(
            task_title="Test",
            required_domains=["backend"],
        )

        online = make_agent("backend_dev", status="idle")
        offline = make_agent("devops", status="offline")
        orchestrator.registry.list_agents = AsyncMock(
            return_value=[online, offline],
        )

        result = await orchestrator.route_task(cid, req)
        assert result.agent_id == online.id
        assert result.agent_role == "backend_dev"

    async def test_excludes_busy_but_saturated_is_last_resort(self, orchestrator, mock_db):
        """A fully saturated agent is not the selection when a free one exists."""
        cid = uuid.uuid4()
        req = AgentRouteRequest(
            task_title="API task",
            required_domains=["api"],
        )

        free = make_agent("backend_dev", load=0, max_tasks=3, status="idle")
        saturated = make_agent("backend_dev", load=3, max_tasks=3, status="busy")
        orchestrator.registry.list_agents = AsyncMock(
            return_value=[free, saturated],
        )

        result = await orchestrator.route_task(cid, req)
        assert result.agent_id == free.id

    async def test_all_offline_raises(self, orchestrator, mock_db):
        """When every agent is offline, routing should raise RuntimeError."""
        cid = uuid.uuid4()
        req = AgentRouteRequest(task_title="test")
        orchestrator.registry.list_agents = AsyncMock(
            return_value=[make_agent("backend_dev", status="offline")],
        )

        with pytest.raises(RuntimeError, match="No eligible agents"):
            await orchestrator.route_task(cid, req)


# ── Batch cross-agent routing ────────────────────────────────────────────────

class TestBatchRouting:
    """Cross-agent routing: multiple sub-tasks distributed across agents."""

    async def test_routes_tasks_to_different_agents(self, orchestrator, mock_db):
        """When tasks require different domains, route to the best-fit agents."""
        cid = uuid.uuid4()
        agents = [
            make_agent("frontend_dev", capabilities={"frontend": 1.0, "ui": 1.0}, load=0, status="idle"),
            make_agent("backend_dev", capabilities={"backend": 1.0, "api": 1.0}, load=0, status="idle"),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=agents)

        requests = [
            AgentRouteRequest(task_title="Build UI", required_domains=["frontend", "ui"]),
            AgentRouteRequest(task_title="Build API", required_domains=["backend", "api"]),
        ]

        result = await orchestrator.batch_route_tasks(cid, requests)
        assert len(result.assignments) == 2
        assert len(result.unassigned) == 0

        # Frontend task -> frontend agent, backend task -> backend agent
        roles = {a.agent_role for a in result.assignments}
        assert "frontend_dev" in roles
        assert "backend_dev" in roles

    async def test_load_balanced_across_agents(self, orchestrator, mock_db):
        """When multiple agents can do the work, distribute across them."""
        cid = uuid.uuid4()
        agents = [
            make_agent("backend_dev", capabilities={"backend": 1.0, "api": 1.0}, load=0, max_tasks=2, status="idle"),
            make_agent("backend_dev", capabilities={"backend": 1.0, "api": 1.0}, load=0, max_tasks=2, status="idle"),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=agents)

        requests = [
            AgentRouteRequest(task_title="Task A", required_domains=["backend"]),
            AgentRouteRequest(task_title="Task B", required_domains=["backend"]),
        ]

        result = await orchestrator.batch_route_tasks(cid, requests)
        assert len(result.assignments) == 2

        # Both agents should be used (load balancing)
        assigned_agents = {a.agent_id for a in result.assignments}
        assert len(assigned_agents) == 2

    async def test_priority_order(self, orchestrator, mock_db):
        """High-priority tasks should be assigned before low-priority ones."""
        cid = uuid.uuid4()
        agents = [
            make_agent("backend_dev", capabilities={"backend": 1.0}, load=0, max_tasks=1, status="idle"),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=agents)

        requests = [
            AgentRouteRequest(task_title="Low priority", required_domains=["backend"], priority="low"),
            AgentRouteRequest(task_title="High priority", required_domains=["backend"], priority="high"),
        ]

        result = await orchestrator.batch_route_tasks(cid, requests)
        assert len(result.assignments) == 1
        # Only high-priority task fits within capacity
        assert result.assignments[0].agent_id == agents[0].id
        assert result.unassigned == ["Low priority"]

    async def test_saturated_agents_leave_unassigned(self, orchestrator, mock_db):
        """When agents have no capacity, tasks are returned as unassigned."""
        cid = uuid.uuid4()
        agents = [
            make_agent("backend_dev", load=3, max_tasks=3, status="busy"),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=agents)

        requests = [
            AgentRouteRequest(task_title="Overflow task", required_domains=["backend"]),
        ]

        result = await orchestrator.batch_route_tasks(cid, requests)
        assert len(result.assignments) == 0
        assert result.unassigned == ["Overflow task"]

    async def test_no_healthy_candidates_all_unassigned(self, orchestrator, mock_db):
        """If no healthy agents exist, all tasks are unassigned."""
        cid = uuid.uuid4()
        orchestrator.registry.list_agents = AsyncMock(return_value=[])

        requests = [
            AgentRouteRequest(task_title="Task 1", required_domains=["backend"]),
            AgentRouteRequest(task_title="Task 2", required_domains=["frontend"]),
        ]

        result = await orchestrator.batch_route_tasks(cid, requests)
        assert len(result.assignments) == 0
        assert len(result.unassigned) == 2

    async def test_tracks_virtual_load_across_assignments(self, orchestrator, mock_db):
        """The second task should see the first task's load increase."""
        cid = uuid.uuid4()
        single = make_agent("backend_dev", capabilities={"backend": 1.0}, load=0, max_tasks=1, status="idle")
        orchestrator.registry.list_agents = AsyncMock(return_value=[single])

        requests = [
            AgentRouteRequest(task_title="First task", required_domains=["backend"], priority="high"),
            AgentRouteRequest(task_title="Second task", required_domains=["backend"], priority="high"),
        ]

        result = await orchestrator.batch_route_tasks(cid, requests)
        assert len(result.assignments) == 1  # only one fits in capacity
        assert len(result.unassigned) == 1
        assert result.unassigned == ["Second task"]


# ── Workflow step routing ────────────────────────────────────────────────────

class TestRouteWorkflowStep:
    """Workflow step routing maps action names to agents."""

    async def test_routes_by_preferred_role(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        step = {"action": "execute_tasks", "agent": "backend_dev"}
        available = {"backend_dev": True, "frontend_dev": False}

        orchestrator.registry.list_agents = AsyncMock(
            return_value=[make_agent("backend_dev", status="idle")],
        )

        result = await orchestrator.route_workflow_step(cid, step, available)
        assert result is not None
        assert result.agent_role == "backend_dev"


# ── Cross-agent assign_tasks (route + assign in one call) ────────────────

class MockTask:
    """Simulates a Task model instance with the fields ``assign_tasks`` reads."""
    def __init__(self, id, title, assignee_role="backend_dev", priority="medium",
                 description=None, metadata=None):
        self.id = id
        self.title = title
        self.assignee_role = assignee_role
        self.priority = priority
        self.description = description
        self.metadata = metadata or {}
        self.assignee_agent_id = None


class TestAssignTasks:
    """``assign_tasks`` routes Task model instances and persists assignments."""

    async def test_batch_assigns_tasks_to_agents(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        tasks = [
            MockTask(uuid.uuid4(), "Build frontend page", assignee_role="frontend_dev",
                     metadata={"required_domains": ["frontend", "ui"]}),
            MockTask(uuid.uuid4(), "Build API endpoint", assignee_role="backend_dev",
                     metadata={"required_domains": ["backend", "api"]}),
        ]
        agents = [
            make_agent("frontend_dev", capabilities={"frontend": 1.0, "ui": 1.0}, load=0, status="idle"),
            make_agent("backend_dev", capabilities={"backend": 1.0, "api": 1.0}, load=0, status="idle"),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=agents)

        results = await orchestrator.assign_tasks(cid, tasks, batch=True)

        assert len(results) == 2
        # Each task should have a unique agent assignment
        assert results[0]["agent_id"] is not None
        assert results[1]["agent_id"] is not None
        # Task assignee_agent_id should be populated
        assert tasks[0].assignee_agent_id is not None
        assert tasks[1].assignee_agent_id is not None
        mock_db.flush.assert_awaited()

    async def test_batch_unroutable_tasks_return_none_agent(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        tasks = [
            MockTask(uuid.uuid4(), "Overflow task", metadata={"required_domains": ["backend"]}),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=[])

        results = await orchestrator.assign_tasks(cid, tasks, batch=True)

        assert len(results) == 1
        assert results[0]["agent_id"] is None
        assert results[0]["score"] == 0

    async def test_individual_mode_routes_each_task(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        tasks = [
            MockTask(uuid.uuid4(), "Review code", assignee_role="cto",
                     metadata={"required_domains": ["code_review"]}),
        ]
        cto = make_agent("cto", capabilities={"code_review": 0.9}, load=0, status="idle")
        orchestrator.registry.list_agents = AsyncMock(return_value=[cto])

        results = await orchestrator.assign_tasks(cid, tasks, batch=False)

        assert len(results) == 1
        assert results[0]["agent_role"] == "cto"
        assert tasks[0].assignee_agent_id is not None

    async def test_individual_mode_handles_no_candidates(self, orchestrator, mock_db):
        cid = uuid.uuid4()
        tasks = [
            MockTask(uuid.uuid4(), "Lone task", assignee_role="backend_dev"),
        ]
        orchestrator.registry.list_agents = AsyncMock(return_value=[])

        results = await orchestrator.assign_tasks(cid, tasks, batch=False)

        assert len(results) == 1
        assert results[0]["agent_id"] is None
