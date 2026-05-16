"use client";

import { useState, useMemo } from "react";
import type { ApprovalType } from "@/lib/types";
import { approvals, activityFeed, stats, analytics } from "@/lib/data";
import { StatsRow } from "@/components/StatsCard";
import { ApprovalList } from "@/components/ApprovalList";
import { ActivityFeed } from "@/components/ActivityFeed";
import { FilterBar } from "@/components/FilterBar";
import { AnalyticsPanel } from "@/components/AnalyticsPanel";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function ApprovalsDashboard() {
  const [selectedTypes, setSelectedTypes] = useState<ApprovalType[]>([]);
  const [selectedRisk, setSelectedRisk] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleType = (type: ApprovalType) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const resetFilters = () => {
    setSelectedTypes([]);
    setSelectedRisk(null);
    setSearch("");
  };

  const hasActiveFilters = selectedTypes.length > 0 || selectedRisk !== null || search !== "";

  const filteredApprovals = useMemo(() => {
    let result = approvals;

    if (selectedTypes.length > 0) {
      result = result.filter((a) => selectedTypes.includes(a.type));
    }
    if (selectedRisk) {
      result = result.filter((a) => a.riskLevel === selectedRisk);
    }
    if (search.trim()) {
      const query = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.title.toLowerCase().includes(query) ||
          a.taskIdentifier.toLowerCase().includes(query) ||
          a.agentName.toLowerCase().includes(query) ||
          a.reason.toLowerCase().includes(query)
      );
    }

    return result;
  }, [selectedTypes, selectedRisk, search]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
          {filteredApprovals.length > 0 && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
              {filteredApprovals.length} pending
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500">
          Review and act on agent requests that require human judgment.
        </p>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 flex items-center gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-red-800 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => { setError(null); setLoading(true); setTimeout(() => setLoading(false), 600); }}
            className="text-sm font-medium text-red-800 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* KPI Stats */}
      <div className="mb-8">
        <StatsRow stats={stats} />
      </div>

      {/* Filters */}
      <div className="mb-6">
        <FilterBar
          selectedTypes={selectedTypes}
          onTypeToggle={toggleType}
          selectedRisk={selectedRisk}
          onRiskChange={setSelectedRisk}
          search={search}
          onSearchChange={setSearch}
        />
      </div>

      {/* Main content: Approvals + Activity */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-12">
        {/* Approvals list */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Pending Approvals
            {filteredApprovals.length > 0 && (
              <span className="ml-2 text-gray-400 font-normal normal-case">
                ({filteredApprovals.length})
              </span>
            )}
          </h2>

          {filteredApprovals.length > 0 ? (
            <ApprovalList approvals={filteredApprovals} />
          ) : (
            <EmptyState
              variant={hasActiveFilters ? "empty" : "all-reviewed"}
              onResetFilters={hasActiveFilters ? resetFilters : undefined}
            />
          )}
        </div>

        {/* Activity feed */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Recent Activity
          </h2>
          <ActivityFeed events={activityFeed} />
        </div>
      </div>

      {/* Analytics */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
          Analytics
        </h2>
        <AnalyticsPanel data={analytics} />
      </div>
    </div>
  );
}
