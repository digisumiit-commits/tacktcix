"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, DollarSign, Plus, AlertTriangle, CheckCircle,
  PauseCircle, RefreshCw, Trash2, Edit3, X, Activity,
  Brain, Workflow, Building2, Bell,
} from "lucide-react";
import type {
  BudgetCap, BudgetCapCreate, BudgetCapUpdate, BudgetAlert,
  BudgetCapStatusResponse,
} from "@/lib/types";
import * as api from "@/lib/api";

const SCOPE_LABELS: Record<string, string> = {
  agent: "Agent",
  workflow: "Workflow",
  company: "Company",
};

const SCOPE_ICONS: Record<string, React.ElementType> = {
  agent: Brain,
  workflow: Workflow,
  company: Building2,
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function getUsageColor(pct: number): string {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-brand-500";
}

function getUsageTextColor(pct: number): string {
  if (pct >= 100) return "text-red-400";
  if (pct >= 80) return "text-amber-400";
  return "text-green-400";
}

function BudgetContent() {
  const searchParams = useSearchParams();
  const companyId = searchParams.get("companyId");

  const [caps, setCaps] = useState<BudgetCap[]>([]);
  const [capStatuses, setCapStatuses] = useState<Record<string, BudgetCapStatusResponse>>({});
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingCap, setEditingCap] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [activeTab, setActiveTab] = useState<"caps" | "alerts">("caps");

  // Create form state
  const [formData, setFormData] = useState<BudgetCapCreate>({
    scope: "agent",
    scope_id: "",
    monthly_cents: 10000,
    alert_thresholds: [80, 100],
    notify_agent_ids: [],
  });

  // Edit form state
  const [editData, setEditData] = useState<BudgetCapUpdate>({});

  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [capsData, alertsData] = await Promise.all([
        api.listBudgetCaps(companyId, scopeFilter || undefined),
        api.listBudgetAlerts(companyId),
      ]);
      setCaps(capsData.items);
      setAlerts(alertsData.items);

      // Load status for each cap
      const statusMap: Record<string, BudgetCapStatusResponse> = {};
      await Promise.all(
        capsData.items.map(async (cap) => {
          try {
            statusMap[cap.id] = await api.getBudgetCapStatus(companyId, cap.id);
          } catch { /* skip */ }
        }),
      );
      setCapStatuses(statusMap);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load budget data");
    } finally {
      setLoading(false);
    }
  }, [companyId, scopeFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCheckAll = async () => {
    if (!companyId) return;
    setChecking(true);
    try {
      const result = await api.checkBudget(companyId);
      await loadData();
      alert(`Budget check complete: ${result.alerts_fired} alert(s) fired`);
    } catch (err: unknown) {
      alert(`Check failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setChecking(false);
    }
  };

  const handleCheckCap = async (capId: string) => {
    if (!companyId) return;
    try {
      await api.checkBudget(companyId, capId);
      await loadData();
    } catch (err: unknown) {
      alert(`Check failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleCreateCap = async () => {
    if (!companyId) return;
    setCreateError(null);
    try {
      await api.createBudgetCap(companyId, formData);
      setShowCreateForm(false);
      setFormData({ scope: "agent", scope_id: "", monthly_cents: 10000, alert_thresholds: [80, 100], notify_agent_ids: [] });
      await loadData();
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create cap");
    }
  };

  const handleUpdateCap = async (capId: string) => {
    if (!companyId) return;
    setEditError(null);
    try {
      await api.updateBudgetCap(companyId, capId, editData);
      setEditingCap(null);
      setEditData({});
      await loadData();
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "Failed to update cap");
    }
  };

  const handleDeleteCap = async (capId: string) => {
    if (!companyId) return;
    if (!confirm("Delete this budget cap? This cannot be undone.")) return;
    try {
      await api.deleteBudgetCap(companyId, capId);
      await loadData();
    } catch (err: unknown) {
      alert(`Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  if (!companyId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <p className="text-red-400 mb-4">No company ID provided</p>
          <Link href="/" className="btn-secondary">Back to Home</Link>
        </div>
      </div>
    );
  }

  const pendingAlerts = alerts.filter((a) => a.action === "alert").length;
  const pausedAlerts = alerts.filter((a) => a.action === "paused").length;

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href={`/dashboard?companyId=${companyId}`} className="text-gray-500 hover:text-gray-300 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-brand-400" />
                <h1 className="text-xl font-semibold text-white">Budget Management</h1>
              </div>
              <p className="text-sm text-gray-500">Set budget caps, track spend, and manage alerts</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCheckAll}
              disabled={checking}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-brand-400 bg-gray-800/50 hover:bg-gray-800 px-3 py-1.5 rounded-full transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
              {checking ? "Checking..." : "Check All"}
            </button>
            <button
              onClick={() => { setShowCreateForm(true); setCreateError(null); }}
              className="flex items-center gap-1.5 text-xs text-white bg-brand-600 hover:bg-brand-500 px-3 py-1.5 rounded-full transition-colors"
            >
              <Plus className="w-3 h-3" /> New Cap
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-brand-400 mb-1">
              <DollarSign className="w-4 h-4" />
              <span className="text-xs font-medium">Total Caps</span>
            </div>
            <div className="text-2xl font-bold text-white">{caps.length}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-green-400 mb-1">
              <CheckCircle className="w-4 h-4" />
              <span className="text-xs font-medium">Active</span>
            </div>
            <div className="text-2xl font-bold text-white">{caps.filter((c) => c.status === "active").length}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-amber-400 mb-1">
              <Bell className="w-4 h-4" />
              <span className="text-xs font-medium">Alerts</span>
            </div>
            <div className="text-2xl font-bold text-white">{pendingAlerts}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-red-400 mb-1">
              <PauseCircle className="w-4 h-4" />
              <span className="text-xs font-medium">Paused</span>
            </div>
            <div className="text-2xl font-bold text-white">{pausedAlerts}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-800">
          {(["caps", "alerts"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-all ${
                activeTab === tab
                  ? "border-brand-500 text-brand-400"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {tab === "caps" ? "Budget Caps" : "Alert History"}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 rounded-full bg-brand-500/10 flex items-center justify-center animate-pulse">
              <DollarSign className="w-4 h-4 text-brand-400" />
            </div>
            <span className="ml-3 text-gray-400">Loading budget data...</span>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-red-400">{error}</p>
          </div>
        ) : activeTab === "caps" ? (
          <>
            {/* Scope filter */}
            <div className="flex gap-2 mb-4">
              {["", "agent", "workflow", "company"].map((s) => (
                <button
                  key={s}
                  onClick={() => setScopeFilter(s)}
                  className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                    scopeFilter === s
                      ? "bg-brand-600/20 text-brand-400 border border-brand-500/30"
                      : "bg-gray-800/50 text-gray-400 border border-gray-700 hover:bg-gray-800"
                  }`}
                >
                  {s ? SCOPE_LABELS[s] : "All"}
                </button>
              ))}
            </div>

            {caps.length === 0 ? (
              <div className="text-center py-16">
                <DollarSign className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-500 mb-2">No budget caps configured</p>
                <p className="text-sm text-gray-600 mb-4">Set a budget cap to start tracking spend for agents, workflows, or your company.</p>
                <button
                  onClick={() => { setShowCreateForm(true); setCreateError(null); }}
                  className="inline-flex items-center gap-1.5 text-sm text-white bg-brand-600 hover:bg-brand-500 px-4 py-2 rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" /> Create Budget Cap
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {caps.map((cap) => {
                  const Icon = SCOPE_ICONS[cap.scope] || DollarSign;
                  const status = capStatuses[cap.id];
                  const usagePct = status?.usage_pct ?? 0;

                  return (
                    <div key={cap.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                      {editingCap === cap.id ? (
                        /* Edit mode */
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Monthly Budget ($)</label>
                              <input
                                type="number"
                                value={(editData.monthly_cents ?? cap.monthly_cents) / 100}
                                onChange={(e) => setEditData({ ...editData, monthly_cents: Math.round(parseFloat(e.target.value) * 100) })}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Status</label>
                              <select
                                value={editData.status ?? cap.status}
                                onChange={(e) => setEditData({ ...editData, status: e.target.value as "active" | "inactive" })}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                              >
                                <option value="active">Active</option>
                                <option value="inactive">Inactive</option>
                              </select>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Alert Thresholds (%)</label>
                              <input
                                type="text"
                                value={(editData.alert_thresholds ?? cap.alert_thresholds).join(", ")}
                                onChange={(e) => setEditData({ ...editData, alert_thresholds: e.target.value.split(",").map((v) => parseInt(v.trim())).filter((n) => !isNaN(n)) })}
                                placeholder="80, 100"
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                              />
                            </div>
                          </div>
                          {editError && <p className="text-xs text-red-400">{editError}</p>}
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleUpdateCap(cap.id)}
                              className="text-xs bg-brand-600 hover:bg-brand-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setEditingCap(null); setEditData({}); setEditError(null); }}
                              className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded-lg transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Display mode */
                        <>
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                                cap.scope === "agent" ? "bg-blue-500/10 text-blue-400" :
                                cap.scope === "workflow" ? "bg-purple-500/10 text-purple-400" :
                                "bg-green-500/10 text-green-400"
                              }`}>
                                <Icon className="w-5 h-5" />
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <h3 className="text-sm font-medium text-white">{SCOPE_LABELS[cap.scope]}: {cap.scope_id.substring(0, 12)}...</h3>
                                  {cap.status === "active" ? (
                                    <span className="text-[10px] px-2 py-0.5 bg-green-500/10 text-green-400 rounded-full">Active</span>
                                  ) : (
                                    <span className="text-[10px] px-2 py-0.5 bg-gray-700 text-gray-400 rounded-full">Inactive</span>
                                  )}
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5">
                                  Limit: {formatCents(cap.monthly_cents)} &middot; Thresholds: {cap.alert_thresholds.join("% / ")}%
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleCheckCap(cap.id)}
                                className="p-1.5 text-gray-500 hover:text-brand-400 transition-colors"
                                title="Check budget"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => { setEditingCap(cap.id); setEditData({}); setEditError(null); }}
                                className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                                title="Edit cap"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteCap(cap.id)}
                                className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                                title="Delete cap"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Progress bar */}
                          <div className="mt-3">
                            <div className="flex items-center justify-between text-xs mb-1.5">
                              <span className={getUsageTextColor(usagePct)}>
                                {formatCents(status?.spent_cents ?? 0)} spent
                              </span>
                              <span className="text-gray-500">
                                {formatCents(cap.monthly_cents)} limit
                              </span>
                              <span className={`font-medium ${getUsageTextColor(usagePct)}`}>
                                {usagePct.toFixed(1)}%
                              </span>
                            </div>
                            <div className="w-full bg-gray-800 rounded-full h-2">
                              <div
                                className={`h-2 rounded-full transition-all ${getUsageColor(usagePct)}`}
                                style={{ width: `${Math.min(usagePct, 100)}%` }}
                              />
                            </div>
                          </div>

                          {/* State info */}
                          {status?.paused && (
                            <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
                              <PauseCircle className="w-3 h-3" />
                              Agent paused due to budget exceeded
                            </div>
                          )}
                          {cap.notify_agent_ids.length > 0 && (
                            <div className="mt-1.5 text-[10px] text-gray-600">
                              Notifies: {cap.notify_agent_ids.length} agent(s)
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          /* Alerts tab */
          <div>
            {alerts.length === 0 ? (
              <div className="text-center py-16">
                <Bell className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-500">No alerts yet</p>
                <p className="text-sm text-gray-600 mt-1">Alerts will appear here when budget thresholds are breached.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div key={alert.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        {alert.action === "paused" ? (
                          <PauseCircle className="w-5 h-5 text-red-400" />
                        ) : (
                          <AlertTriangle className="w-5 h-5 text-amber-400" />
                        )}
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-medium ${
                              alert.action === "paused" ? "text-red-400" : "text-amber-400"
                            }`}>
                              Threshold {alert.threshold}% — {alert.action === "paused" ? "Agent Paused" : "Alert"}
                            </span>
                            <span className="text-[10px] text-gray-600">{new Date(alert.sent_at).toLocaleString()}</span>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {formatCents(alert.spent_cents)} / {formatCents(alert.monthly_cents)} ({alert.usage_pct.toFixed(1)}%)
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create cap modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Create Budget Cap</h2>
              <button onClick={() => setShowCreateForm(false)} className="text-gray-500 hover:text-gray-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Scope</label>
                <select
                  value={formData.scope}
                  onChange={(e) => setFormData({ ...formData, scope: e.target.value as "agent" | "workflow" | "company" })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="agent">Agent</option>
                  <option value="workflow">Workflow</option>
                  <option value="company">Company</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  {formData.scope === "agent" ? "Agent ID" : formData.scope === "workflow" ? "Workflow ID" : "Company ID"}
                </label>
                <input
                  type="text"
                  value={formData.scope_id}
                  onChange={(e) => setFormData({ ...formData, scope_id: e.target.value })}
                  placeholder={formData.scope === "company" ? companyId : `Enter ${formData.scope} ID`}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Monthly Budget ($)</label>
                <input
                  type="number"
                  value={formData.monthly_cents / 100}
                  onChange={(e) => setFormData({ ...formData, monthly_cents: Math.round(parseFloat(e.target.value) * 100) })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Alert Thresholds (%) — comma separated</label>
                <input
                  type="text"
                  value={formData.alert_thresholds?.join(", ") ?? ""}
                  onChange={(e) => setFormData({ ...formData, alert_thresholds: e.target.value.split(",").map((v) => parseInt(v.trim())).filter((n) => !isNaN(n)) })}
                  placeholder="80, 100"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>

              {createError && <p className="text-xs text-red-400">{createError}</p>}

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleCreateCap}
                  className="flex-1 bg-brand-600 hover:bg-brand-500 text-white text-sm py-2 rounded-lg transition-colors"
                >
                  Create
                </button>
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm py-2 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BudgetPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <DollarSign className="w-6 h-6 text-brand-400" />
          </div>
          <p className="text-gray-400">Loading budget management...</p>
        </div>
      </div>
    }>
      <BudgetContent />
    </Suspense>
  );
}
