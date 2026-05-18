"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  XCircle,
  Activity,
  Workflow,
  Bot,
  Brain,
  ChevronDown,
} from "lucide-react";
import clsx from "clsx";
import type { ActivityEvent, EventTypeFilter } from "@/lib/types";
import { useActivityFeed } from "@/lib/useActivityFeed";
import * as api from "@/lib/api";

// ── Helpers ──────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<
  EventTypeFilter,
  { icon: React.ElementType; label: string; color: string }
> = {
  task_transition: {
    icon: CheckCircle,
    label: "Task",
    color: "bg-blue-500/10 text-blue-400",
  },
  agent_action: {
    icon: Bot,
    label: "Agent",
    color: "bg-purple-500/10 text-purple-400",
  },
  error: {
    icon: XCircle,
    label: "Error",
    color: "bg-red-500/10 text-red-400",
  },
  workflow_event: {
    icon: Workflow,
    label: "Workflow",
    color: "bg-green-500/10 text-green-400",
  },
};

const ALL_TYPES: EventTypeFilter[] = [
  "task_transition",
  "agent_action",
  "error",
  "workflow_event",
];

const ALL_SOURCES = [
  { value: "", label: "All sources" },
  { value: "system", label: "System" },
  { value: "workflow", label: "Workflows" },
  { value: "ceo", label: "CEO" },
  { value: "cto", label: "CTO" },
  { value: "pm", label: "Product Manager" },
  { value: "frontend_dev", label: "Frontend Dev" },
  { value: "backend_dev", label: "Backend Dev" },
  { value: "ai_dev", label: "AI/ML Dev" },
  { value: "devops", label: "DevOps" },
  { value: "qa", label: "QA" },
  { value: "ux_designer", label: "UX Designer" },
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EventIcon({ event }: { event: ActivityEvent }) {
  const cfg = TYPE_CONFIG[event.type];
  const Icon = cfg?.icon ?? Activity;
  return (
    <div className={clsx("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", cfg?.color ?? "bg-gray-700 text-gray-400")}>
      <Icon className="w-4 h-4" />
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const cfg = TYPE_CONFIG[event.type];

  return (
    <div className="flex items-start gap-3 p-3 bg-gray-800/30 rounded-lg hover:bg-gray-800/50 transition-colors">
      <EventIcon event={event} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={clsx("text-[10px] px-1.5 py-0.5 rounded font-medium", cfg?.color ?? "bg-gray-700 text-gray-400")}>
            {cfg?.label ?? event.type}
          </span>
          <span className="text-xs text-gray-500">{event.source}</span>
          {event.source_id && (
            <span className="text-[10px] text-gray-600 font-mono">#{event.source_id.slice(0, 8)}</span>
          )}
        </div>
        <p className="text-sm text-gray-200 truncate">{event.title}</p>
        {event.description && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{event.description}</p>
        )}
      </div>
      <span className="text-[11px] text-gray-600 flex-shrink-0 whitespace-nowrap">
        {formatTime(event.created_at)}
      </span>
    </div>
  );
}

function FilterBar({
  typeFilter,
  setTypeFilter,
  sourceFilter,
  setSourceFilter,
  connected,
  onRefresh,
}: {
  typeFilter: EventTypeFilter[];
  setTypeFilter: (t: EventTypeFilter[]) => void;
  sourceFilter: string;
  setSourceFilter: (s: string) => void;
  connected: boolean;
  onRefresh: () => void;
}) {
  const [sourceOpen, setSourceOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      {/* Event type toggles */}
      <div className="flex gap-1 flex-wrap">
        <button
          onClick={() => setTypeFilter(typeFilter.length === ALL_TYPES.length ? [] : [...ALL_TYPES])}
          className={clsx(
            "text-[11px] px-2 py-1 rounded-full transition-colors",
            typeFilter.length === ALL_TYPES.length
              ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
              : "bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300"
          )}
        >
          All
        </button>
        {ALL_TYPES.map((t) => {
          const cfg = TYPE_CONFIG[t];
          const active = typeFilter.includes(t);
          return (
            <button
              key={t}
              onClick={() => {
                setTypeFilter(
                  active
                    ? typeFilter.filter((x) => x !== t)
                    : [...typeFilter, t]
                );
              }}
              className={clsx(
                "text-[11px] px-2 py-1 rounded-full transition-colors flex items-center gap-1",
                active
                  ? cfg.color + " border border-current/30"
                  : "bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300"
              )}
            >
              <cfg.icon className="w-3 h-3" />
              {cfg.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* Connection indicator */}
      <span className={clsx(
        "flex items-center gap-1 text-[11px]",
        connected ? "text-green-400" : "text-gray-500"
      )}>
        <span className={clsx(
          "w-1.5 h-1.5 rounded-full",
          connected ? "bg-green-400" : "bg-gray-600"
        )} />
        {connected ? "Live" : "Polling"}
      </span>

      {/* Refresh button */}
      <button
        onClick={onRefresh}
        className="text-gray-500 hover:text-gray-300 transition-colors p-1"
        title="Refresh"
      >
        <RefreshCw className="w-4 h-4" />
      </button>

      {/* Source filter */}
      <div className="relative">
        <button
          onClick={() => setSourceOpen(!sourceOpen)}
          className="flex items-center gap-1 text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 hover:text-gray-300"
        >
          {ALL_SOURCES.find((s) => s.value === sourceFilter)?.label ?? "All sources"}
          <ChevronDown className="w-3 h-3" />
        </button>
        {sourceOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setSourceOpen(false)} />
            <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
              {ALL_SOURCES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => {
                    setSourceFilter(s.value);
                    setSourceOpen(false);
                  }}
                  className={clsx(
                    "w-full text-left text-xs px-3 py-1.5 hover:bg-gray-700 transition-colors",
                    sourceFilter === s.value ? "text-brand-400" : "text-gray-400"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page content ──────────────────────────────────────────────────

function ActivityFeedContent() {
  const searchParams = useSearchParams();
  const companyId = searchParams.get("companyId") ?? "";

  const [typeFilter, setTypeFilter] = useState<EventTypeFilter[]>([...ALL_TYPES]);
  const [sourceFilter, setSourceFilter] = useState("");
  // Track initial fetch + SSE state separately so "loading" goes away
  // after the first successful data (SSE or poll), not just after SSE connects.
  const [initialLoading, setInitialLoading] = useState(true);

  // Fetch initial events on mount to prepopulate the feed.
  const [initialEvents, setInitialEvents] = useState<ActivityEvent[]>([]);
  useEffect(() => {
    if (!companyId) return;
    setInitialLoading(true);
    api.getEvents(companyId, { limit: 50 })
      .then((events) => setInitialEvents(events))
      .catch(() => { /* ignore — the hook will surface errors */ })
      .finally(() => setInitialLoading(false));
  }, [companyId]);

  const { events, loading, error, connected } = useActivityFeed({
    companyId,
    initialEvents,
    typeFilter,
    sourceFilter: sourceFilter || undefined,
  });

  // Manual refresh — re-fetches from the polling endpoint.
  const handleRefresh = useCallback(() => {
    api.getEvents(companyId, {
      types: typeFilter,
      source: sourceFilter || undefined,
      limit: 50,
    }).then((data) => setInitialEvents(data)).catch(() => {});
  }, [companyId, typeFilter, sourceFilter]);

  if (!companyId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <p className="text-red-400 mb-4">No company ID provided</p>
          <Link href="/" className="btn-secondary">Back to Home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href={`/dashboard?companyId=${companyId}`}
              className="text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-white">Activity Feed</h1>
              <p className="text-sm text-gray-500">Real-time events across agents, tasks, and workflows</p>
            </div>
          </div>

          <Link
            href={`/dashboard?companyId=${companyId}`}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Dashboard
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-6">
        <FilterBar
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          sourceFilter={sourceFilter}
          setSourceFilter={setSourceFilter}
          connected={connected}
          onRefresh={handleRefresh}
        />

        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {initialLoading ? (
          <div className="text-center py-20">
            <div className="w-10 h-10 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
              <Brain className="w-5 h-5 text-brand-400" />
            </div>
            <p className="text-gray-500 text-sm">Loading activity feed...</p>
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-20">
            <Activity className="w-10 h-10 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-500 text-sm">No activity events yet</p>
            <p className="text-gray-600 text-xs mt-1">
              Events will appear here as agents work, tasks change, and workflows run.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ActivityFeedPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Brain className="w-5 h-5 text-brand-400" />
          </div>
          <p className="text-gray-500 text-sm">Loading...</p>
        </div>
      </div>
    }>
      <ActivityFeedContent />
    </Suspense>
  );
}
