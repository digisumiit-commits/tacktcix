"""Real-time activity feed: SSE stream + polling fallback."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from app.core.database import get_db
from app.models.company import ActivityEvent, Company
from app.models.onboarding import ActivityEventResponse
from app.services.event_service import EventTypes, bus, EventService

router = APIRouter(prefix="/api/v1/events", tags=["events"])


# ---------------------------------------------------------------------------
# SSE stream
# ---------------------------------------------------------------------------

async def _event_stream(
    company_id: str,
    request: Request,
    db: AsyncSession,
    type_filter: set[str] | None,
) -> None:
    """Yield SSE-formatted events as they arrive on the in-memory bus."""
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)
    bus.subscribe(company_id, queue)

    try:
        # Send initial heartbeat so the client knows the connection is open.
        yield f"event: connected\ndata: {json.dumps({'status': 'ok'})}\n\n"

        while True:
            # Check if the client disconnected.
            if await request.is_disconnected():
                break

            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # Send keep-alive comment to prevent proxies / browsers
                # from closing idle connections.
                yield ": keepalive\n\n"
                continue

            event_type = event.get("type", "event")

            # Apply client-side type filter if present.
            if type_filter and event_type not in type_filter:
                continue

            yield (
                f"event: {event_type}\n"
                f"id: {event['id']}\n"
                f"data: {json.dumps(event, default=str)}\n\n"
            )
    finally:
        bus.unsubscribe(company_id, queue)


@router.get("/stream")
async def stream_events(
    request: Request,
    company_id: str = Query(..., description="Company UUID to stream events for"),
    types: str | None = Query(None, description="Comma-separated event type filter"),
    db: AsyncSession = Depends(get_db),
):
    """Server-Sent Events endpoint.

    Clients connect via EventSource / fetch and receive a stream of activity
    events as they are recorded.  Supports an optional `types` query param
    to filter by event type (comma-separated).

    Fallback: clients that can't use EventSource should poll ``GET /``.
    """
    # Validate company exists
    try:
        company_uuid = uuid.UUID(company_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid company_id")

    result = await db.execute(select(Company).where(Company.id == company_uuid))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Company not found")

    type_filter: set[str] | None = None
    if types:
        parts = [t.strip() for t in types.split(",")]
        valid = {EventTypes.TASK_TRANSITION, EventTypes.AGENT_ACTION, EventTypes.ERROR, EventTypes.WORKFLOW_EVENT}
        type_filter = set(parts) & valid
        if not type_filter:
            raise HTTPException(status_code=400, detail=f"Invalid type filter. Valid types: {', '.join(valid)}")

    return StreamingResponse(
        _event_stream(company_id, request, db, type_filter),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Polling fallback — list / filter historical events
# ---------------------------------------------------------------------------

@router.get("", response_model=list[ActivityEventResponse])
async def list_events(
    company_id: str = Query(..., description="Company UUID"),
    types: str | None = Query(None, description="Comma-separated event types to include"),
    source: str | None = Query(None, description="Filter by source name"),
    since: datetime | None = Query(None, description="ISO-8601 timestamp — return events after this"),
    before: datetime | None = Query(None, description="ISO-8601 timestamp — return events before this"),
    limit: int = Query(50, ge=1, le=200, description="Max events to return"),
    db: AsyncSession = Depends(get_db),
):
    """Polling fallback — returns a paginated list of historical events.

    Use this endpoint when SSE is unavailable (e.g. serverless, restrictive
    proxies).  Results are ordered newest-first.
    """
    try:
        company_uuid = uuid.UUID(company_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid company_id")

    # Verify company exists
    result = await db.execute(select(Company).where(Company.id == company_uuid))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Company not found")

    type_list: list[str] | None = None
    if types:
        type_list = [t.strip() for t in types.split(",")]

    svc = EventService(db)
    events = await svc.get_events(
        company_uuid,
        types=type_list,
        source=source,
        since=since,
        before=before,
        limit=limit,
    )
    return events


@router.get("/{event_id}", response_model=ActivityEventResponse)
async def get_event(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get a single event by ID."""
    svc = EventService(db)
    event = await svc.get_event_by_id(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


# ---------------------------------------------------------------------------
# Convenience endpoint for emitting events (used by services internally)
# ---------------------------------------------------------------------------

from pydantic import BaseModel


class EmitEventRequest(BaseModel):
    company_id: str
    type: str
    source: str
    title: str
    source_id: str | None = None
    description: str | None = None
    metadata: dict | None = None


@router.post("/emit", status_code=201)
async def emit_event(
    payload: EmitEventRequest,
    db: AsyncSession = Depends(get_db),
):
    """Manually emit an activity event (for testing / webhook integration)."""
    valid_types = {EventTypes.TASK_TRANSITION, EventTypes.AGENT_ACTION, EventTypes.ERROR, EventTypes.WORKFLOW_EVENT}
    if payload.type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid type '{payload.type}'. Valid: {', '.join(valid_types)}",
        )

    try:
        company_uuid = uuid.UUID(payload.company_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid company_id")

    svc = EventService(db)
    event = await svc.record_event(
        company_id=company_uuid,
        type=payload.type,
        source=payload.source,
        title=payload.title,
        source_id=payload.source_id,
        description=payload.description,
        metadata=payload.metadata,
    )
    return ActivityEventResponse.model_validate(event)
