"""Tests for the real-time activity feed: event bus, service, and API."""

import asyncio
import uuid
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.company import ActivityEvent
from app.services.event_service import EventBus, EventService, EventTypes


# ═════════════════════════════════════════════════════════════════════════════
# EventBus
# ═════════════════════════════════════════════════════════════════════════════

class TestEventBus:
    async def test_subscribe_and_publish(self):
        """Subscribers receive published events."""
        bus = EventBus()
        q: asyncio.Queue = asyncio.Queue()

        cid = str(uuid.uuid4())
        bus.subscribe(cid, q)
        bus.publish({"company_id": cid, "type": "test", "id": "1"})

        item = await asyncio.wait_for(q.get(), timeout=1.0)
        assert item["id"] == "1"
        assert item["type"] == "test"

    async def test_wildcard_subscriber_gets_all(self):
        """Subscribers on '*' receive events for any company."""
        bus = EventBus()
        q: asyncio.Queue = asyncio.Queue()

        bus.subscribe("*", q)
        bus.publish({"company_id": str(uuid.uuid4()), "type": "test"})
        bus.publish({"company_id": str(uuid.uuid4()), "type": "test2"})

        item1 = await asyncio.wait_for(q.get(), timeout=1.0)
        item2 = await asyncio.wait_for(q.get(), timeout=1.0)
        assert {item1["type"], item2["type"]} == {"test", "test2"}

    async def test_unsubscribe_removes_queue(self):
        bus = EventBus()
        q: asyncio.Queue = asyncio.Queue()
        cid = str(uuid.uuid4())

        bus.subscribe(cid, q)
        bus.unsubscribe(cid, q)
        bus.publish({"company_id": cid, "type": "test"})

        with pytest.raises(asyncio.QueueEmpty):
            q.get_nowait()

    async def test_full_queue_does_not_block(self):
        """publish should not raise when a subscriber's queue is full."""
        bus = EventBus()
        q: asyncio.Queue = asyncio.Queue(maxsize=1)
        cid = str(uuid.uuid4())

        bus.subscribe(cid, q)
        q.put_nowait({"placeholder": True})  # fill the queue

        # This should not raise
        bus.publish({"company_id": cid, "type": "dropped"})

    async def test_multiple_subscribers_same_company(self):
        bus = EventBus()
        q1: asyncio.Queue = asyncio.Queue()
        q2: asyncio.Queue = asyncio.Queue()
        cid = str(uuid.uuid4())

        bus.subscribe(cid, q1)
        bus.subscribe(cid, q2)
        bus.publish({"company_id": cid, "type": "broadcast"})

        assert (await asyncio.wait_for(q1.get(), timeout=1.0))["type"] == "broadcast"
        assert (await asyncio.wait_for(q2.get(), timeout=1.0))["type"] == "broadcast"


# ═════════════════════════════════════════════════════════════════════════════
# EventService
# ═════════════════════════════════════════════════════════════════════════════

@pytest.fixture
def mock_db():
    return AsyncMock()


@pytest.fixture
def svc(mock_db):
    return EventService(mock_db)


class TestRecordEvent:
    async def test_record_event_persists_and_publishes(self, svc, mock_db):
        cid = uuid.uuid4()

        def set_attrs():
            svc.db.add.call_args[0][0].id = uuid.uuid4()
            svc.db.add.call_args[0][0].created_at = datetime.utcnow()

        mock_db.flush = AsyncMock(side_effect=set_attrs)
        mock_db.add = MagicMock()

        event = await svc.record_event(
            company_id=cid,
            type=EventTypes.TASK_TRANSITION,
            source="system",
            title="Test event",
            description="A test",
            metadata={"key": "val"},
        )

        assert isinstance(event, ActivityEvent)
        assert event.type == EventTypes.TASK_TRANSITION
        assert event.source == "system"
        assert event.title == "Test event"
        assert event.description == "A test"
        assert event.metadata == {"key": "val"}
        mock_db.add.assert_called_once()
        mock_db.flush.assert_awaited_once()

    async def test_record_event_minimal(self, svc, mock_db):
        cid = uuid.uuid4()

        def set_attrs():
            svc.db.add.call_args[0][0].id = uuid.uuid4()
            svc.db.add.call_args[0][0].created_at = datetime.utcnow()

        mock_db.flush = AsyncMock(side_effect=set_attrs)
        mock_db.add = MagicMock()

        event = await svc.record_event(
            company_id=cid,
            type=EventTypes.AGENT_ACTION,
            source="cto",
            title="Minimal event",
        )

        assert event.title == "Minimal event"
        assert event.metadata == {}
        assert event.source_id is None
        assert event.description is None


class TestConvenienceMethods:
    async def test_task_transition(self, svc, mock_db):
        cid = uuid.uuid4()
        mock_db.add = MagicMock()
        mock_db.flush = AsyncMock()

        def set_attrs():
            ev = svc.db.add.call_args[0][0]
            ev.id = uuid.uuid4()
            ev.created_at = datetime.utcnow()

        mock_db.flush = AsyncMock(side_effect=set_attrs)

        event = await svc.task_transition(
            cid, "Build feature", "todo", "in_progress",
            source="pm",
        )

        assert event.type == EventTypes.TASK_TRANSITION
        assert "Build feature" in event.title
        assert "in_progress" in event.title
        assert event.metadata["old_status"] == "todo"
        assert event.metadata["new_status"] == "in_progress"

    async def test_agent_action(self, svc, mock_db):
        cid = uuid.uuid4()
        mock_db.add = MagicMock()
        mock_db.flush = AsyncMock()

        def set_attrs():
            ev = svc.db.add.call_args[0][0]
            ev.id = uuid.uuid4()
            ev.created_at = datetime.utcnow()

        mock_db.flush = AsyncMock(side_effect=set_attrs)

        event = await svc.agent_action(
            cid, "CEO Agent", "Reviewed strategy",
            description="CEO reviewed quarterly strategy",
        )

        assert event.type == EventTypes.AGENT_ACTION
        assert event.source == "CEO Agent"
        assert event.title == "Reviewed strategy"

    async def test_error_event(self, svc, mock_db):
        cid = uuid.uuid4()
        mock_db.add = MagicMock()
        mock_db.flush = AsyncMock()

        def set_attrs():
            ev = svc.db.add.call_args[0][0]
            ev.id = uuid.uuid4()
            ev.created_at = datetime.utcnow()

        mock_db.flush = AsyncMock(side_effect=set_attrs)

        event = await svc.error_event(
            cid, "workflow", "Workflow timeout",
            description="Step 'deploy' timed out after 30s",
        )

        assert event.type == EventTypes.ERROR
        assert "Workflow timeout" in event.title

    async def test_workflow_event(self, svc, mock_db):
        cid = uuid.uuid4()
        mock_db.add = MagicMock()
        mock_db.flush = AsyncMock()

        def set_attrs():
            ev = svc.db.add.call_args[0][0]
            ev.id = uuid.uuid4()
            ev.created_at = datetime.utcnow()

        mock_db.flush = AsyncMock(side_effect=set_attrs)

        event = await svc.workflow_event(
            cid, "Deploy Pipeline", "started",
            description="Deploy pipeline version 2.1 started",
        )

        assert event.type == EventTypes.WORKFLOW_EVENT
        assert "Deploy Pipeline" in event.title
        assert "started" in event.title


class TestQueryMethods:
    async def test_get_events(self, svc, mock_db):
        cid = uuid.uuid4()

        class FakeScalars:
            def all(self):
                return [
                    ActivityEvent(id=uuid.uuid4(), company_id=cid, type="task_transition", source="system", title="E1"),
                    ActivityEvent(id=uuid.uuid4(), company_id=cid, type="agent_action", source="ceo", title="E2"),
                ]

        class FakeResult:
            def scalars(self, *args, **kwargs):
                return FakeScalars()

        mock_db.execute = AsyncMock(return_value=FakeResult())

        events = await svc.get_events(cid, types=["task_transition"], limit=10)
        assert len(events) == 2

    async def test_get_events_with_source_filter(self, svc, mock_db):
        cid = uuid.uuid4()

        class FakeScalars:
            def all(self):
                return [ActivityEvent(id=uuid.uuid4(), company_id=cid, type="agent_action", source="ceo", title="E1")]

        class FakeResult:
            def scalars(self, *args, **kwargs):
                return FakeScalars()

        mock_db.execute = AsyncMock(return_value=FakeResult())

        events = await svc.get_events(cid, source="ceo", limit=50)
        assert len(events) == 1

    async def test_get_event_by_id_found(self, svc, mock_db):
        eid = uuid.uuid4()
        event = ActivityEvent(id=eid, company_id=uuid.uuid4(), type="test", source="sys", title="E1")
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=event)

        result = await svc.get_event_by_id(eid)
        assert result is not None
        assert result.id == eid

    async def test_get_event_by_id_not_found(self, svc, mock_db):
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=None)

        result = await svc.get_event_by_id(uuid.uuid4())
        assert result is None


# ═════════════════════════════════════════════════════════════════════════════
# Event integration with AgentRegistryService
# ═════════════════════════════════════════════════════════════════════════════

class TestAgentRegistryEventEmission:
    async def test_register_agent_emits_event(self, mock_db):
        from app.services.agent_registry_service import AgentRegistryService
        from app.models.agent import AgentRegister

        mock_events = MagicMock()
        mock_events.agent_action = AsyncMock()
        registry = AgentRegistryService(mock_db, mock_events)

        payload = AgentRegister(role="ceo", name="CEO Agent")
        mock_db.add = MagicMock()
        mock_db.flush = AsyncMock()

        await registry.register_agent(uuid.uuid4(), payload)

        mock_events.agent_action.assert_awaited_once()

    async def test_assign_task_emits_event(self, mock_db):
        from app.services.agent_registry_service import AgentRegistryService
        from app.models.agent import Agent

        mock_events = MagicMock()
        mock_events.task_transition = AsyncMock()
        registry = AgentRegistryService(mock_db, mock_events)

        agent_id = uuid.uuid4()
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=Agent(
            id=agent_id, company_id=uuid.uuid4(), role="pm", name="PM Agent",
            max_concurrent_tasks=3, current_load=0,
        ))
        mock_db.flush = AsyncMock()

        await registry.assign_task(agent_id, task_title="Plan sprint")

        mock_events.task_transition.assert_awaited_once()

    async def test_assign_task_no_events_when_not_configured(self, mock_db):
        """Backward compat: registry without events should work."""
        from app.services.agent_registry_service import AgentRegistryService
        from app.models.agent import Agent

        registry = AgentRegistryService(mock_db)

        agent_id = uuid.uuid4()
        mock_db.execute.return_value.scalar_one_or_none = MagicMock(return_value=Agent(
            id=agent_id, company_id=uuid.uuid4(), role="qa", name="QA Agent",
            max_concurrent_tasks=3, current_load=0,
        ))
        mock_db.flush = AsyncMock()

        updated = await registry.assign_task(agent_id)
        assert updated.current_load == 1
        # No AttributeError from missing events
