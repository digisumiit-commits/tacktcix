"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ActivityEvent, EventTypeFilter } from "./types";
import { getEvents, getEventStreamUrl } from "./api";

interface UseActivityFeedOptions {
  companyId: string;
  /** Initial batch of events to prepopulate (avoids flash). */
  initialEvents?: ActivityEvent[];
  /** Event type filters applied client-side. */
  typeFilter?: EventTypeFilter[];
  /** Source name filter. */
  sourceFilter?: string;
  /** How often to poll as fallback (ms). Default 10s. */
  pollInterval?: number;
  /** Enable SSE. Default true. Falls back to polling automatically. */
  useSSE?: boolean;
}

export function useActivityFeed({
  companyId,
  initialEvents = [],
  typeFilter,
  sourceFilter,
  pollInterval = 10_000,
  useSSE = true,
}: UseActivityFeedOptions) {
  const [events, setEvents] = useState<ActivityEvent[]>(initialEvents);
  const [loading, setLoading] = useState(initialEvents.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const lastEventIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Sync externally-fetched initial events into state (e.g. from SSR / initial fetch).
  useEffect(() => {
    if (initialEvents.length === 0) return;
    setEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const newOnes = initialEvents.filter((e) => !existingIds.has(e.id));
      if (newOnes.length === 0) return prev;
      return [...newOnes, ...prev];
    });
  }, [initialEvents]);

  // Update lastEventId whenever events change (for polling pagination).
  useEffect(() => {
    if (events.length > 0) {
      lastEventIdRef.current = events[0].id;
    }
  }, [events]);

  // ── Apply filters client-side to the full list ──────────────
  const filtered = events.filter((e) => {
    if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(e.type)) return false;
    if (sourceFilter && e.source !== sourceFilter) return false;
    return true;
  });

  // ── SSE connection ─────────────────────────────────────────
  const connectSSE = useCallback(() => {
    if (!useSSE || !companyId) return;

    const typesParam = typeFilter?.length ? typeFilter.join(",") : undefined;
    const url = getEventStreamUrl(companyId, typesParam);

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setError(null);
      setLoading(false);
    };

    // Listen for all event types
    const eventTypes = ["task_transition", "agent_action", "error", "workflow_event"];
    for (const t of eventTypes) {
      es.addEventListener(t, (msg: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const event = JSON.parse(msg.data) as ActivityEvent;
          setEvents((prev) => {
            // Deduplicate by ID
            if (prev.some((e) => e.id === event.id)) return prev;
            return [event, ...prev];
          });
          lastEventIdRef.current = event.id;
        } catch {
          // Ignore parse errors
        }
      });
    }

    // Fallback: if SSE fails, switch to polling
    es.onerror = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      es.close();
      eventSourceRef.current = null;
      startPolling();
    };
  }, [companyId, useSSE, typeFilter?.join(",")]);

  // ── Polling fallback ────────────────────────────────────────
  const poll = useCallback(async () => {
    if (!companyId) return;
    try {
      const data = await getEvents(companyId, {
        types: typeFilter,
        source: sourceFilter,
        limit: 50,
      });
      if (!mountedRef.current) return;
      setEvents(data);
      if (data.length > 0) {
        lastEventIdRef.current = data[0].id;
      }
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Polling failed");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [companyId, typeFilter?.join(","), sourceFilter]);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    poll(); // immediate first poll
    pollTimerRef.current = setInterval(poll, pollInterval);
  }, [poll, pollInterval]);

  // ── Lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);

    if (useSSE) {
      connectSSE();
    } else {
      startPolling();
    }

    return () => {
      mountedRef.current = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [connectSSE, startPolling, useSSE]);

  return {
    events: filtered,
    allEvents: events,
    loading,
    error,
    connected,
  };
}
