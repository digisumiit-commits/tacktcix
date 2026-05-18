"""In-memory pub/sub event service for real-time activity feed.

Uses an asyncio.Queue per subscriber so slow consumers don't block others.
Only intended for single-instance deployments. For multi-instance, swap
the EventBus for Redis pub/sub without changing the publish/subscribe API.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.company import ActivityEvent


# ---------------------------------------------------------------------------
# Event bus — in-memory async pub/sub
# ---------------------------------------------------------------------------

class EventBus:
    """Simple async pub/sub.  Subscribe returns an asyncio.Queue that receives
    serialised event dicts.  Unsubscribe removes the queue."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = {}

    def subscribe(self, company_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.setdefault(company_id, []).append(queue)

    def unsubscribe(self, company_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        queues = self._subscribers.get(company_id, [])
        if queue in queues:
            queues.remove(queue)

    def publish(self, event: dict[str, Any]) -> None:
        company_id = event["company_id"]
        for queue in self._subscribers.get(company_id, []):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass  # drop events for slow consumers
        # Also notify wildcard listeners (e.g. admin views)
        for queue in self._subscribers.get("*", []):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass


# Singleton bus — imported by both the service layer and the SSE endpoint.
bus = EventBus()


# ---------------------------------------------------------------------------
# Event type constants
# ---------------------------------------------------------------------------

class EventTypes:
    TASK_TRANSITION = "task_transition"
    AGENT_ACTION = "agent_action"
    ERROR = "error"
    WORKFLOW_EVENT = "workflow_event"


EVENT_TYPES = [
    EventTypes.TASK_TRANSITION,
    EventTypes.AGENT_ACTION,
    EventTypes.ERROR,
    EventTypes.WORKFLOW_EVENT,
]


# ---------------------------------------------------------------------------
# High-level event recording + publishing
# ---------------------------------------------------------------------------

class EventService:
    """Records events to the database and publishes them to the in-memory bus."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def record_event(
        self,
        company_id: uuid.UUID,
        type: str,
        source: str,
        title: str,
        *,
        source_id: str | None = None,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ActivityEvent:
        event = ActivityEvent(
            company_id=company_id,
            type=type,
            source=source,
            source_id=source_id,
            title=title,
            description=description,
            metadata=metadata or {},
        )
        self.db.add(event)
        await self.db.flush()

        # Publish to in-memory bus for real-time subscribers.
        bus.publish({
            "id": str(event.id),
            "company_id": str(event.company_id),
            "type": event.type,
            "source": event.source,
            "source_id": event.source_id,
            "title": event.title,
            "description": event.description,
            "metadata": event.metadata,
            "created_at": event.created_at.isoformat(),
        })

        return event

    # ── Convenience shortcuts ──────────────────────────────────────────

    async def task_transition(
        self,
        company_id: uuid.UUID,
        task_title: str,
        old_status: str,
        new_status: str,
        *,
        source: str = "system",
        source_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ActivityEvent:
        return await self.record_event(
            company_id=company_id,
            type=EventTypes.TASK_TRANSITION,
            source=source,
            source_id=source_id,
            title=f"Task \"{task_title}\" → {new_status}",
            description=f"Status changed from {old_status} to {new_status}",
            metadata={"old_status": old_status, "new_status": new_status, **(metadata or {})},
        )

    async def agent_action(
        self,
        company_id: uuid.UUID,
        agent_name: str,
        action: str,
        *,
        source_id: str | None = None,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ActivityEvent:
        return await self.record_event(
            company_id=company_id,
            type=EventTypes.AGENT_ACTION,
            source=agent_name,
            source_id=source_id,
            title=action,
            description=description,
            metadata=metadata,
        )

    async def error_event(
        self,
        company_id: uuid.UUID,
        source: str,
        error_title: str,
        *,
        source_id: str | None = None,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ActivityEvent:
        return await self.record_event(
            company_id=company_id,
            type=EventTypes.ERROR,
            source=source,
            source_id=source_id,
            title=error_title,
            description=description,
            metadata=metadata,
        )

    async def workflow_event(
        self,
        company_id: uuid.UUID,
        workflow_name: str,
        event: str,
        *,
        source_id: str | None = None,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ActivityEvent:
        return await self.record_event(
            company_id=company_id,
            type=EventTypes.WORKFLOW_EVENT,
            source="workflow",
            source_id=source_id,
            title=f"Workflow \"{workflow_name}\" — {event}",
            description=description,
            metadata={"workflow_name": workflow_name, **(metadata or {})},
        )

    # ── Query helpers (polling fallback) ───────────────────────────────

    async def get_events(
        self,
        company_id: uuid.UUID,
        *,
        types: list[str] | None = None,
        source: str | None = None,
        since: datetime | None = None,
        before: datetime | None = None,
        limit: int = 50,
    ) -> list[ActivityEvent]:
        query = select(ActivityEvent).where(
            ActivityEvent.company_id == company_id
        ).order_by(ActivityEvent.created_at.desc()).limit(limit)

        if types:
            query = query.where(ActivityEvent.type.in_(types))
        if source:
            query = query.where(ActivityEvent.source == source)
        if since:
            query = query.where(ActivityEvent.created_at >= since)
        if before:
            query = query.where(ActivityEvent.created_at <= before)

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_event_by_id(self, event_id: uuid.UUID) -> ActivityEvent | None:
        result = await self.db.execute(
            select(ActivityEvent).where(ActivityEvent.id == event_id)
        )
        return result.scalar_one_or_none()
