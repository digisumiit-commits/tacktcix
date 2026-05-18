"""Tests for the agent registry service."""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.agent import Agent, AgentRegister, AgentUpdate
from app.services.agent_registry_service import (
    AgentRegistryService,
    ROLE_CAPABILITIES,
)


@pytest.fixture
def mock_db():
    return AsyncMock()


@pytest.fixture
def registry(mock_db):
    return AgentRegistryService(mock_db)


def make_agent(role="backend_dev", capabilities=None, cost=1.0,
               max_tasks=3, load=0, status="idle", **kw):
    return Agent(
        id=uuid.uuid4(),
        company_id=uuid.uuid4(),
        role=role,
        name=f"{role} Agent",
        capabilities=capabilities or ROLE_CAPABILITIES.get(role, {}),
        cost_per_task=cost,
        max_concurrent_tasks=max_tasks,
        current_load=load,
        status=status,
        **(kw or {}),
    )


class TestRegister:
    async def test_registers_agent_with_inferred_capabilities(self, registry, mock_db):
        payload = AgentRegister(role="frontend_dev", name="Frontend Agent")
        agent = await registry.register_agent(uuid.uuid4(), payload)

        assert agent.role == "frontend_dev"
        assert agent.capabilities == ROLE_CAPABILITIES["frontend_dev"]
        assert agent.cost_per_task == 1.0
        assert agent.current_load == 0
        assert agent.status == "idle"
        mock_db.add.assert_called_once()
        mock_db.flush.assert_awaited_once()

    async def test_registers_agent_with_custom_capabilities(self, registry, mock_db):
        caps = {"frontend": 0.9, "design": 0.5}
        payload = AgentRegister(role="designer", name="Custom Designer", capabilities=caps)
        agent = await registry.register_agent(uuid.uuid4(), payload)

        assert agent.capabilities == caps
        assert agent.cost_per_task == 1.2  # from ROLE_COST


class TestListAgents:
    async def test_filters_by_role(self, registry, mock_db):
        cid = uuid.uuid4()

        class FakeResult:
            def scalars(self):
                return self
            def all(self):
                return [make_agent(role="ceo"), make_agent(role="cto")]

        mock_db.execute = AsyncMock(return_value=FakeResult())
        agents = await registry.list_agents(cid, role="ceo")
        assert len(agents) == 2

    async def test_filters_by_status(self, registry, mock_db):
        cid = uuid.uuid4()
        busy = make_agent(role="qa", status="busy")

        class FakeResult:
            def scalars(self):
                return self
            def all(self):
                return [busy]

        mock_db.execute = AsyncMock(return_value=FakeResult())
        agents = await registry.list_agents(cid, status="busy")
        assert len(agents) == 1
        assert agents[0].status == "busy"

    async def test_returns_empty_when_none_match(self, registry, mock_db):
        cid = uuid.uuid4()

        class FakeResult:
            def scalars(self):
                return self
            def all(self):
                return []

        mock_db.execute = AsyncMock(return_value=FakeResult())
        agents = await registry.list_agents(cid)
        assert agents == []


class TestHeartbeat:
    async def test_updates_load_and_status(self, registry, mock_db):
        agent_id = uuid.uuid4()
        existing = make_agent(current_load=2, status="busy")
        mock_db.execute = AsyncMock()
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=existing)

        updated = await registry.update_heartbeat(agent_id, current_load=1, status="idle")
        assert updated.current_load == 1
        assert updated.status == "idle"
        mock_db.flush.assert_awaited_once()

    async def test_returns_none_for_missing_agent(self, registry, mock_db):
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=None)
        result = await registry.update_heartbeat(uuid.uuid4(), 0, "idle")
        assert result is None


class TestLoadManagement:
    async def test_assign_task_increments_load(self, registry, mock_db):
        agent_id = uuid.uuid4()
        agent = make_agent(current_load=1, max_concurrent_tasks=3)
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=agent)

        updated = await registry.assign_task(agent_id)
        assert updated.current_load == 2
        assert updated.status == "idle"  # 2 < 3

    async def test_assign_task_marks_busy_at_capacity(self, registry, mock_db):
        agent_id = uuid.uuid4()
        agent = make_agent(current_load=2, max_concurrent_tasks=3)
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=agent)

        updated = await registry.assign_task(agent_id)
        assert updated.current_load == 3
        assert updated.status == "busy"  # 3 >= 3

    async def test_complete_task_decrements_load(self, registry, mock_db):
        agent_id = uuid.uuid4()
        agent = make_agent(current_load=2, max_concurrent_tasks=3, status="busy")
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=agent)

        updated = await registry.complete_task(agent_id)
        assert updated.current_load == 1
        assert updated.status == "idle"  # back under capacity

    async def test_complete_task_does_not_go_below_zero(self, registry, mock_db):
        agent_id = uuid.uuid4()
        agent = make_agent(current_load=0)
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=agent)

        updated = await registry.complete_task(agent_id)
        assert updated.current_load == 0


class TestSeedDefaultAgents:
    async def test_seeds_all_nine_roles(self, registry, mock_db):
        cid = uuid.uuid4()

        # No existing agents
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=None)
        mock_db.add = MagicMock()
        mock_db.flush = AsyncMock()

        # Make list_agents return empty first time
        class EmptyResult:
            def scalars(self):
                return self
            def all(self):
                return []

        class FullResult:
            def scalars(self):
                return self
            def all(self):
                return [make_agent(role=r) for r in ["ceo", "cto", "pm", "frontend_dev", "backend_dev", "ai_dev", "devops", "qa", "designer"]]

        # First call (check existing) → empty, second call (after flush) → full list
        mock_db.execute = AsyncMock(side_effect=[EmptyResult(), FullResult()])

        agents = await registry.seed_default_agents(cid)
        assert len(agents) == 9
        roles = {a.role for a in agents}
        assert roles == {"ceo", "cto", "pm", "frontend_dev", "backend_dev", "ai_dev", "devops", "qa", "designer"}
