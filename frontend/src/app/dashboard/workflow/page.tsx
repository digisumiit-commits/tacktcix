"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Workflow, Plus, Play, X, AlertTriangle, CheckCircle,
  Clock, PauseCircle, Trash2, Eye, RefreshCw, Activity, Edit3,
  FileText, ListTodo,
} from "lucide-react";
import * as api from "@/lib/api";
import type {
  WorkflowDefinitionSummary,
  WorkflowExecutionSummary,
  WorkflowStepExecutionSummary,
} from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-700 text-gray-400",
  active: "bg-green-500/10 text-green-400",
  paused: "bg-amber-500/10 text-amber-400",
  completed: "bg-blue-500/10 text-blue-400",
  failed: "bg-red-500/10 text-red-400",
};

const EXEC_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-700 text-gray-400",
  running: "bg-blue-500/10 text-blue-400",
  completed: "bg-green-500/10 text-green-400",
  failed: "bg-red-500/10 text-red-400",
  cancelled: "bg-gray-700 text-gray-400",
  timed_out: "bg-red-500/10 text-red-400",
  paused: "bg-amber-500/10 text-amber-400",
};

function WorkflowContent() {
  const searchParams = useSearchParams();
  const companyId = searchParams.get("companyId");

  const [definitions, setDefinitions] = useState<WorkflowDefinitionSummary[]>([]);
  const [executions, setExecutions] = useState<WorkflowExecutionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"definitions" | "executions">("definitions");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedDef, setSelectedDef] = useState<WorkflowDefinitionSummary | null>(null);
  const [selectedExecSteps, setSelectedExecSteps] = useState<WorkflowStepExecutionSummary[] | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [startingExec, setStartingExec] = useState<string | null>(null);

  // Create form
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    stepCount: 2,
  });

  const loadData = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [defData, execData] = await Promise.all([
        api.listWorkflowDefinitions(companyId, statusFilter || undefined),
        api.listWorkflowExecutions(companyId),
      ]);
      setDefinitions(defData.items);
      setExecutions(execData.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workflow data");
    } finally {
      setLoading(false);
    }
  }, [companyId, statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = async () => {
    if (!companyId || !formData.name.trim()) return;
    setCreateError(null);
    try {
      const steps = Array.from({ length: formData.stepCount }, (_, i) => ({
        id: `s${i + 1}`,
        name: `Step ${i + 1}`,
        config: { type: "action", handler: "noop", input: {} },
      }));
      const edges = formData.stepCount > 1
        ? Array.from({ length: formData.stepCount - 1 }, (_, i) => ({
            id: `e${i + 1}`,
            from: `s${i + 1}`,
            to: `s${i + 2}`,
          }))
        : [];

      await api.createWorkflowDefinition(companyId, {
        name: formData.name,
        description: formData.description,
        steps,
        edges,
      });
      setShowCreateForm(false);
      setFormData({ name: "", description: "", stepCount: 2 });
      await loadData();
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workflow");
    }
  };

  const handleStartExecution = async (definitionId: string) => {
    if (!companyId) return;
    setStartingExec(definitionId);
    try {
      await api.startWorkflowExecution(companyId, definitionId);
      await loadData();
    } catch (err: unknown) {
      alert(`Failed to start execution: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setStartingExec(null);
    }
  };

  const handleCancelExecution = async (executionId: string) => {
    if (!companyId) return;
    try {
      await api.cancelWorkflowExecution(companyId, executionId);
      await loadData();
    } catch (err: unknown) {
      alert(`Failed to cancel: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleViewSteps = async (executionId: string) => {
    if (!companyId) return;
    try {
      const result = await api.listWorkflowStepExecutions(companyId, executionId);
      setSelectedExecSteps(result.steps);
    } catch (err: unknown) {
      alert(`Failed to load steps: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleDelete = async (definitionId: string) => {
    if (!companyId) return;
    if (!confirm("Delete this workflow definition? This cannot be undone.")) return;
    try {
      await api.deleteWorkflowDefinition(companyId, definitionId);
      await loadData();
    } catch (err: unknown) {
      alert(`Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleDeleteExecution = async (executionId: string) => {
    if (!companyId) return;
    if (!confirm("Delete this workflow execution?")) return;
    try {
      // Execution deletion not available via API, but we can refresh
      await loadData();
    } catch { /* ignore */ }
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
                <Workflow className="w-5 h-5 text-brand-400" />
                <h1 className="text-xl font-semibold text-white">Workflow Engine</h1>
              </div>
              <p className="text-sm text-gray-500">Define DAG workflows and manage executions</p>
            </div>
          </div>
          <button
            onClick={() => { setShowCreateForm(true); setCreateError(null); }}
            className="flex items-center gap-1.5 text-xs text-white bg-brand-600 hover:bg-brand-500 px-3 py-1.5 rounded-full transition-colors"
          >
            <Plus className="w-3 h-3" /> New Workflow
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-brand-400 mb-1">
              <FileText className="w-4 h-4" />
              <span className="text-xs font-medium">Definitions</span>
            </div>
            <div className="text-2xl font-bold text-white">{definitions.length}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-blue-400 mb-1">
              <Activity className="w-4 h-4" />
              <span className="text-xs font-medium">Executions</span>
            </div>
            <div className="text-2xl font-bold text-white">{executions.length}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-green-400 mb-1">
              <CheckCircle className="w-4 h-4" />
              <span className="text-xs font-medium">Completed</span>
            </div>
            <div className="text-2xl font-bold text-white">
              {executions.filter((e) => e.status === "completed").length}
            </div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-red-400 mb-1">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-medium">Failed</span>
            </div>
            <div className="text-2xl font-bold text-white">
              {executions.filter((e) => e.status === "failed").length}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-800">
          {(["definitions", "executions"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-all ${
                activeTab === tab
                  ? "border-brand-500 text-brand-400"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {tab === "definitions" ? "Workflow Definitions" : "Execution History"}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 rounded-full bg-brand-500/10 flex items-center justify-center animate-pulse">
              <Workflow className="w-4 h-4 text-brand-400" />
            </div>
            <span className="ml-3 text-gray-400">Loading workflow data...</span>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-red-400">{error}</p>
          </div>
        ) : activeTab === "definitions" ? (
          <>
            {/* Status filter */}
            <div className="flex gap-2 mb-4">
              {["", "draft", "active", "paused", "completed", "failed"].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                    statusFilter === s
                      ? "bg-brand-600/20 text-brand-400 border border-brand-500/30"
                      : "bg-gray-800/50 text-gray-400 border border-gray-700 hover:bg-gray-800"
                  }`}
                >
                  {s ? s.charAt(0).toUpperCase() + s.slice(1) : "All"}
                </button>
              ))}
            </div>

            {definitions.length === 0 ? (
              <div className="text-center py-16">
                <Workflow className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-500 mb-2">No workflow definitions</p>
                <p className="text-sm text-gray-600 mb-4">Create your first DAG workflow to get started.</p>
                <button
                  onClick={() => { setShowCreateForm(true); setCreateError(null); }}
                  className="inline-flex items-center gap-1.5 text-sm text-white bg-brand-600 hover:bg-brand-500 px-4 py-2 rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" /> Create Workflow
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {definitions.map((def) => (
                  <div key={def.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-brand-500/10 flex items-center justify-center flex-shrink-0">
                          <Workflow className="w-5 h-5 text-brand-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-medium text-white truncate">{def.name}</h3>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLORS[def.status] || "bg-gray-700 text-gray-400"}`}>
                              {def.status}
                            </span>
                            <span className="text-[10px] text-gray-600">v{def.version}</span>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5 truncate">
                            {def.description || "No description"} &middot; {def.steps.length} step(s) &middot; {def.edges.length} edge(s)
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-3 flex-shrink-0">
                        <button
                          onClick={() => handleStartExecution(def.id)}
                          disabled={startingExec === def.id}
                          className="p-1.5 text-gray-500 hover:text-green-400 transition-colors disabled:opacity-50"
                          title="Start execution"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setSelectedDef(def)}
                          className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                          title="View details"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(def.id)}
                          className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          /* Executions tab */
          <div>
            {executions.length === 0 ? (
              <div className="text-center py-16">
                <Activity className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-500">No executions yet</p>
                <p className="text-sm text-gray-600 mt-1">Start a workflow execution to see it here.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {executions.map((exec) => (
                  <div key={exec.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          exec.status === "completed" ? "bg-green-500/10 text-green-400" :
                          exec.status === "failed" || exec.status === "timed_out" ? "bg-red-500/10 text-red-400" :
                          exec.status === "running" ? "bg-blue-500/10 text-blue-400" :
                          "bg-gray-700 text-gray-400"
                        }`}>
                          {exec.status === "completed" ? <CheckCircle className="w-5 h-5" /> :
                           exec.status === "failed" || exec.status === "timed_out" ? <AlertTriangle className="w-5 h-5" /> :
                           exec.status === "running" ? <RefreshCw className="w-5 h-5 animate-spin" /> :
                           <Clock className="w-5 h-5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-medium text-white truncate">
                              Execution: {exec.id.substring(0, 12)}...
                            </h3>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${EXEC_STATUS_COLORS[exec.status] || "bg-gray-700 text-gray-400"}`}>
                              {exec.status}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Workflow: {exec.workflow_id.substring(0, 12)}... &middot;
                            Started: {exec.started_at ? new Date(exec.started_at).toLocaleString() : "Not started"} &middot;
                            {exec.completed_at ? `Completed: ${new Date(exec.completed_at).toLocaleString()}` : ""}
                          </p>
                          {exec.error && (
                            <p className="text-xs text-red-400 mt-1">Error: {exec.error}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-3 flex-shrink-0">
                        <button
                          onClick={() => handleViewSteps(exec.id)}
                          className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                          title="View step executions"
                        >
                          <ListTodo className="w-3.5 h-3.5" />
                        </button>
                        {(exec.status === "running" || exec.status === "pending") && (
                          <button
                            onClick={() => handleCancelExecution(exec.id)}
                            className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                            title="Cancel execution"
                          >
                            <PauseCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create workflow modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Create Workflow Definition</h2>
              <button onClick={() => setShowCreateForm(false)} className="text-gray-500 hover:text-gray-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="My Workflow"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="What does this workflow do?"
                  rows={3}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Number of Steps</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={formData.stepCount}
                  onChange={(e) => setFormData({ ...formData, stepCount: Math.max(1, Math.min(20, parseInt(e.target.value) || 1)) })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                />
                <p className="text-[10px] text-gray-600 mt-1">
                  Creates a linear workflow with {formData.stepCount} step(s) connected in sequence.
                </p>
              </div>

              {createError && <p className="text-xs text-red-400">{createError}</p>}

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleCreate}
                  disabled={!formData.name.trim()}
                  className="flex-1 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition-colors"
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

      {/* Definition detail modal */}
      {selectedDef && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Workflow className="w-5 h-5 text-brand-400" />
                <h2 className="text-lg font-semibold text-white">{selectedDef.name}</h2>
              </div>
              <button onClick={() => setSelectedDef(null)} className="text-gray-500 hover:text-gray-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-sm">
              <div>
                <span className="text-gray-500">Description:</span>
                <p className="text-gray-300 mt-1">{selectedDef.description || "No description"}</p>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <div className="text-lg font-bold text-white">{selectedDef.version}</div>
                  <div className="text-xs text-gray-500">Version</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <div className="text-lg font-bold text-white">{selectedDef.steps.length}</div>
                  <div className="text-xs text-gray-500">Steps</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <div className="text-lg font-bold text-white">{selectedDef.edges.length}</div>
                  <div className="text-xs text-gray-500">Edges</div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Steps</h4>
                <div className="space-y-2">
                  {(selectedDef.steps as Array<{ id: string; name: string; config: { type: string } }>).map((step, i) => (
                    <div key={step.id} className="bg-gray-800/30 rounded-lg p-3 flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-brand-500/20 text-brand-400 text-xs flex items-center justify-center flex-shrink-0">
                        {i + 1}
                      </span>
                      <div>
                        <span className="text-gray-300">{step.name}</span>
                        <span className="text-xs text-gray-500 ml-2">({step.config.type})</span>
                      </div>
                      <span className="text-[10px] text-gray-600 ml-auto">{step.id}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Edges</h4>
                <div className="space-y-1">
                  {(selectedDef.edges as Array<{ id: string; from: string; to: string }>).map((edge) => (
                    <div key={edge.id} className="text-xs text-gray-400 bg-gray-800/20 rounded px-3 py-2">
                      {edge.from} → {edge.to}
                      <span className="text-gray-600 ml-2">({edge.id})</span>
                    </div>
                  ))}
                  {selectedDef.edges.length === 0 && (
                    <p className="text-xs text-gray-600">No edges defined</p>
                  )}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => {
                    handleStartExecution(selectedDef.id);
                    setSelectedDef(null);
                  }}
                  className="flex items-center gap-1.5 bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                >
                  <Play className="w-4 h-4" /> Start Execution
                </button>
                <button
                  onClick={() => setSelectedDef(null)}
                  className="bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm px-4 py-2 rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step executions modal */}
      {selectedExecSteps && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <ListTodo className="w-5 h-5 text-brand-400" />
                <h2 className="text-lg font-semibold text-white">Step Executions</h2>
              </div>
              <button onClick={() => setSelectedExecSteps(null)} className="text-gray-500 hover:text-gray-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {selectedExecSteps.length === 0 ? (
              <p className="text-sm text-gray-500 py-8 text-center">No step executions recorded</p>
            ) : (
              <div className="space-y-3">
                {selectedExecSteps.map((step) => (
                  <div key={step.id} className="bg-gray-800/30 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-300">Step: {step.step_id}</span>
                        {step.attempt > 0 && (
                          <span className="text-[10px] text-gray-600">(attempt {step.attempt + 1})</span>
                        )}
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${EXEC_STATUS_COLORS[step.status] || "bg-gray-700 text-gray-400"}`}>
                        {step.status}
                      </span>
                    </div>
                    {step.error && (
                      <p className="text-xs text-red-400 mb-1">Error: {step.error}</p>
                    )}
                    <div className="text-[10px] text-gray-600">
                      Started: {step.started_at ? new Date(step.started_at).toLocaleString() : "N/A"} &middot;
                      Completed: {step.completed_at ? new Date(step.completed_at).toLocaleString() : "N/A"}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setSelectedExecSteps(null)}
              className="mt-4 w-full bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm py-2 rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function WorkflowPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Workflow className="w-6 h-6 text-brand-400" />
          </div>
          <p className="text-gray-400">Loading workflow engine...</p>
        </div>
      </div>
    }>
      <WorkflowContent />
    </Suspense>
  );
}
