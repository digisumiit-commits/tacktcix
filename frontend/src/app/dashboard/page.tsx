"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Building2, Brain, GitBranch, FileText, ListTodo, Workflow,
  CheckCircle, Clock, AlertTriangle, ChevronRight, ArrowLeft, Activity, DollarSign
} from "lucide-react";
import type { DashboardData } from "@/lib/types";
import * as api from "@/lib/api";

function DashboardContent() {
  const searchParams = useSearchParams();
  const companyId = searchParams.get("companyId");

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "knowledge" | "roadmap" | "tasks">("overview");

  useEffect(() => {
    if (!companyId) {
      setError("No company ID provided");
      setLoading(false);
      return;
    }

    api.getDashboard(companyId)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [companyId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Brain className="w-6 h-6 text-brand-400" />
          </div>
          <p className="text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <p className="text-red-400 mb-4">{error || "Failed to load dashboard"}</p>
          <Link href="/" className="btn-secondary">Back to Home</Link>
        </div>
      </div>
    );
  }

  const { company, stats, tasks, workflows } = data;

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-500 hover:text-gray-300 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-white">{company.name}</h1>
              <p className="text-sm text-gray-500">{company.industry || "Technology"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/dashboard/budget?companyId=${companyId}`}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-400 bg-gray-800/50 hover:bg-gray-800 px-3 py-1.5 rounded-full transition-colors"
            >
              <DollarSign className="w-3 h-3" /> Budget
            </Link>
            <Link
              href={`/dashboard/activity?companyId=${companyId}`}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-400 bg-gray-800/50 hover:bg-gray-800 px-3 py-1.5 rounded-full transition-colors"
            >
              <Activity className="w-3 h-3" /> Activity Feed
            </Link>
            {company.onboarding_completed && (
              <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded-full">
                <CheckCircle className="w-3 h-3" /> Onboarded
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Stats */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard icon={ListTodo} label="Tasks" value={stats.total_tasks} color="blue" />
          <StatCard icon={Workflow} label="Active Workflows" value={stats.active_workflows} color="green" />
          <StatCard icon={Brain} label="AI Models" value={company.selected_models?.providers?.length || 1} color="purple" />
          <StatCard icon={Building2} label="Status" value={stats.onboarding_complete ? "Active" : "Setting up"} color="amber" />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-800">
          {(["overview", "knowledge", "roadmap", "tasks"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-all ${
                activeTab === tab
                  ? "border-brand-500 text-brand-400"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {tab === "overview" ? "Overview" : tab === "knowledge" ? "Knowledge Graph" : tab === "roadmap" ? "Roadmap" : "Tasks"}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {company.vision_statement && (
              <Card title="Vision" icon={FileText}>
                <p className="text-sm text-gray-400 leading-relaxed line-clamp-6">{company.vision_statement}</p>
              </Card>
            )}

            <Card title="Agent Team" icon={Brain}>
              <div className="grid grid-cols-2 gap-2">
                {[
                  "CEO", "CTO", "Product Manager", "Frontend Dev",
                  "Backend Dev", "AI/ML Dev", "DevOps", "QA", "UX Designer", "Marketing"
                ].map((role) => (
                  <div key={role} className="flex items-center gap-2 text-sm text-gray-400">
                    <div className="w-2 h-2 rounded-full bg-brand-500" />
                    {role}
                  </div>
                ))}
              </div>
            </Card>

            <Card title="Active Workflows" icon={Workflow}>
              {workflows.length > 0 ? (
                <div className="space-y-3">
                  {workflows.map((wf) => (
                    <div key={wf.id} className="bg-gray-800/30 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-white">{wf.name}</span>
                        {wf.is_active && (
                          <span className="text-[10px] px-2 py-0.5 bg-green-500/10 text-green-400 rounded-full">Active</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{wf.description}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No workflows yet</p>
              )}
            </Card>

            <Card title="Recent Tasks" icon={ListTodo}>
              {tasks.length > 0 ? (
                <div className="space-y-2">
                  {tasks.slice(0, 8).map((task) => (
                    <div key={task.id} className="flex items-center gap-2 text-sm">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        task.priority === "high" ? "bg-red-400" :
                        task.priority === "medium" ? "bg-amber-400" : "bg-gray-500"
                      }`} />
                      <span className="text-gray-400 truncate">{task.title}</span>
                      <span className="text-xs text-gray-600 ml-auto flex-shrink-0">{task.status}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No tasks yet</p>
              )}
            </Card>
          </div>
        )}

        {activeTab === "knowledge" && (
          <Card title="Knowledge Graph" icon={GitBranch}>
            {data.knowledge_graph ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-sm font-medium text-gray-300 mb-3">Domains</h4>
                  <div className="space-y-2">
                    {Object.entries(data.knowledge_graph.domains || {}).map(([key, domain]) => (
                      <div key={key} className="bg-gray-800/30 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-white">{domain.name}</span>
                          <span className="text-xs text-gray-500">{Math.round(domain.relevance_score * 100)}% match</span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {domain.keywords_matched.slice(0, 3).map((kw) => (
                            <span key={kw} className="text-[10px] px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">{kw}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-gray-300 mb-3">Capabilities</h4>
                  <div className="space-y-2">
                    {Object.entries(data.knowledge_graph.capabilities || {}).map(([key, cap]) => (
                      <div key={key} className="flex items-center gap-2 text-sm text-gray-400">
                        <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />
                        {cap.name}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Knowledge graph not yet generated</p>
            )}
          </Card>
        )}

        {activeTab === "roadmap" && (
          <Card title="Roadmap" icon={ListTodo}>
            {data.roadmap?.phases ? (
              <div className="space-y-4">
                {Object.entries(data.roadmap.phases).map(([key, phase]) => (
                  <div key={key} className="bg-gray-800/30 rounded-xl p-4 border border-gray-700/50">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-medium text-white">
                        Phase {phase.order}: {phase.name}
                      </h4>
                      <span className="text-xs text-gray-500">{phase.duration_weeks} weeks</span>
                    </div>
                    <p className="text-sm text-gray-400 mb-3">{phase.objective}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {phase.deliverables.map((d, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm text-gray-400">
                          <ChevronRight className="w-3 h-3 text-brand-500 flex-shrink-0" />
                          {d}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">Roadmap not yet generated</p>
            )}
          </Card>
        )}

        {activeTab === "tasks" && (
          <Card title="All Tasks" icon={ListTodo}>
            {tasks.length > 0 ? (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-3 p-3 bg-gray-800/30 rounded-lg">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      task.priority === "high" ? "bg-red-400" :
                      task.priority === "medium" ? "bg-amber-400" : "bg-gray-500"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-300 truncate">{task.title}</p>
                      <p className="text-xs text-gray-600 mt-0.5">
                        {task.assignee_role?.replace(/_/g, " ")} &middot; {task.status}
                      </p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                      task.status === "todo" ? "bg-gray-700 text-gray-400" :
                      task.status === "in_progress" ? "bg-blue-500/10 text-blue-400" :
                      task.status === "done" ? "bg-green-500/10 text-green-400" :
                      "bg-gray-700 text-gray-400"
                    }`}>
                      {task.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No tasks yet</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color: "blue" | "green" | "purple" | "amber";
}) {
  const colors = {
    blue: "bg-blue-500/10 text-blue-400",
    green: "bg-green-500/10 text-green-400",
    purple: "bg-purple-500/10 text-purple-400",
    amber: "bg-amber-500/10 text-amber-400",
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${colors[color]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function Card({ title, icon: Icon, children }: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-5 h-5 text-brand-400" />
        <h3 className="font-medium text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Brain className="w-6 h-6 text-brand-400" />
          </div>
          <p className="text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    }>
      <DashboardContent />
    </Suspense>
  );
}
