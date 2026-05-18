import type {
  OnboardingSession,
  OnboardingComplete,
  DashboardData,
  Company,
  ActivityEvent,
  EventTypeFilter,
  BudgetCap,
  BudgetCapCreate,
  BudgetCapUpdate,
  BudgetCapStatusResponse,
  BudgetAlert,
  BudgetCheckResult,
  BudgetListResponse,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const MEMORY_API_BASE = process.env.NEXT_PUBLIC_MEMORY_API_URL || "http://localhost:3100";

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`API error ${res.status}: ${error}`);
  }
  return res.json();
}

export async function startOnboarding(data: {
  name: string;
  slug: string;
  description?: string;
  industry?: string;
  size?: string;
}): Promise<OnboardingSession> {
  return fetchApi("/api/v1/onboarding/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function saveStep(
  companyId: string,
  stepKey: string,
  data: Record<string, unknown>
): Promise<OnboardingSession> {
  return fetchApi(`/api/v1/onboarding/${companyId}/step`, {
    method: "POST",
    body: JSON.stringify({ step: 0, step_key: stepKey, data }),
  });
}

export async function uploadVision(
  companyId: string,
  visionText: string
): Promise<OnboardingSession> {
  return fetchApi(`/api/v1/onboarding/${companyId}/vision`, {
    method: "POST",
    body: JSON.stringify({ vision_text: visionText, format: "text" }),
  });
}

export async function selectModels(
  companyId: string,
  models: { provider: string; model: string; api_key_set: boolean }[]
): Promise<{ status: string; models: Record<string, unknown> }> {
  return fetchApi(`/api/v1/onboarding/${companyId}/models`, {
    method: "POST",
    body: JSON.stringify(models),
  });
}

export async function saveIntegrations(
  companyId: string,
  integrations: Record<string, unknown>
): Promise<{ status: string }> {
  return fetchApi(`/api/v1/onboarding/${companyId}/integrations`, {
    method: "POST",
    body: JSON.stringify(integrations),
  });
}

export async function processOnboarding(
  companyId: string
): Promise<OnboardingComplete> {
  return fetchApi(`/api/v1/onboarding/${companyId}/process`, {
    method: "POST",
  });
}

export async function getSession(
  companyId: string
): Promise<OnboardingSession> {
  return fetchApi(`/api/v1/onboarding/${companyId}/session`);
}

export async function getDashboard(companyId: string): Promise<DashboardData> {
  return fetchApi(`/api/v1/companies/${companyId}/dashboard`);
}

export function getEventStreamUrl(companyId: string, types?: string): string {
  const params = new URLSearchParams({ company_id: companyId });
  if (types) params.set("types", types);
  return `${API_BASE}/api/v1/events/stream?${params.toString()}`;
}

export async function getEvents(
  companyId: string,
  filters?: {
    types?: EventTypeFilter[];
    source?: string;
    since?: string;
    before?: string;
    limit?: number;
  }
): Promise<ActivityEvent[]> {
  const params = new URLSearchParams({ company_id: companyId });
  if (filters?.types?.length) params.set("types", filters.types.join(","));
  if (filters?.source) params.set("source", filters.source);
  if (filters?.since) params.set("since", filters.since);
  if (filters?.before) params.set("before", filters.before);
  if (filters?.limit) params.set("limit", String(filters.limit));
  return fetchApi(`/api/v1/events?${params.toString()}`);
}

// ── Budget API ─────────────────────────────────────────────────────────────

async function fetchMemoryApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${MEMORY_API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Memory API error ${res.status}: ${error}`);
  }
  return res.json();
}

export async function createBudgetCap(
  companyId: string,
  data: BudgetCapCreate
): Promise<BudgetCap> {
  return fetchMemoryApi(`/api/v1/budget/caps?company_id=${companyId}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listBudgetCaps(
  companyId: string,
  scope?: string
): Promise<BudgetListResponse<BudgetCap>> {
  const params = new URLSearchParams({ company_id: companyId });
  if (scope) params.set("scope", scope);
  return fetchMemoryApi(`/api/v1/budget/caps?${params.toString()}`);
}

export async function getBudgetCap(
  companyId: string,
  capId: string
): Promise<BudgetCap> {
  return fetchMemoryApi(`/api/v1/budget/caps/${capId}?company_id=${companyId}`);
}

export async function updateBudgetCap(
  companyId: string,
  capId: string,
  data: BudgetCapUpdate
): Promise<BudgetCap> {
  return fetchMemoryApi(`/api/v1/budget/caps/${capId}?company_id=${companyId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteBudgetCap(
  companyId: string,
  capId: string
): Promise<void> {
  await fetch(`${MEMORY_API_BASE}/api/v1/budget/caps/${capId}?company_id=${companyId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
}

export async function getBudgetCapStatus(
  companyId: string,
  capId: string
): Promise<BudgetCapStatusResponse> {
  return fetchMemoryApi(`/api/v1/budget/status/${capId}?company_id=${companyId}`);
}

export async function checkBudget(
  companyId: string,
  capId?: string
): Promise<BudgetCheckResult> {
  const path = capId
    ? `/api/v1/budget/check/${capId}?company_id=${companyId}`
    : `/api/v1/budget/check?company_id=${companyId}`;
  return fetchMemoryApi(path, { method: "POST" });
}

// ── Workflow API ────────────────────────────────────────────────────────────

export interface WorkflowDefinitionSummary {
  id: string;
  company_id: string;
  name: string;
  description: string;
  version: number;
  status: string;
  steps: unknown[];
  edges: unknown[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowExecutionSummary {
  id: string;
  workflow_id: string;
  company_id: string;
  status: string;
  context: Record<string, unknown>;
  current_step_ids: string[];
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStepExecutionSummary {
  id: string;
  execution_id: string;
  step_id: string;
  status: string;
  attempt: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function createWorkflowDefinition(
  companyId: string,
  data: { name: string; description?: string; steps: unknown[]; edges?: unknown[] }
): Promise<WorkflowDefinitionSummary> {
  return fetchMemoryApi(`/api/v1/workflow/definitions?company_id=${companyId}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listWorkflowDefinitions(
  companyId: string,
  status?: string
): Promise<{ items: WorkflowDefinitionSummary[]; total: number }> {
  const params = new URLSearchParams({ company_id: companyId });
  if (status) params.set("status", status);
  return fetchMemoryApi(`/api/v1/workflow/definitions?${params.toString()}`);
}

export async function getWorkflowDefinition(
  companyId: string,
  definitionId: string
): Promise<WorkflowDefinitionSummary> {
  return fetchMemoryApi(`/api/v1/workflow/definitions/${definitionId}?company_id=${companyId}`);
}

export async function updateWorkflowDefinition(
  companyId: string,
  definitionId: string,
  data: { name?: string; description?: string; status?: string; steps?: unknown[]; edges?: unknown[] }
): Promise<WorkflowDefinitionSummary> {
  return fetchMemoryApi(`/api/v1/workflow/definitions/${definitionId}?company_id=${companyId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteWorkflowDefinition(
  companyId: string,
  definitionId: string
): Promise<void> {
  await fetch(`${MEMORY_API_BASE}/api/v1/workflow/definitions/${definitionId}?company_id=${companyId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
}

export async function startWorkflowExecution(
  companyId: string,
  workflowId: string,
  initialContext?: Record<string, unknown>
): Promise<WorkflowExecutionSummary> {
  return fetchMemoryApi(`/api/v1/workflow/executions?company_id=${companyId}`, {
    method: "POST",
    body: JSON.stringify({ workflowId, initialContext: initialContext ?? {} }),
  });
}

export async function getWorkflowExecution(
  companyId: string,
  executionId: string
): Promise<WorkflowExecutionSummary> {
  return fetchMemoryApi(`/api/v1/workflow/executions/${executionId}?company_id=${companyId}`);
}

export async function listWorkflowExecutions(
  companyId: string,
  workflowId?: string,
  status?: string
): Promise<{ items: WorkflowExecutionSummary[]; total: number }> {
  const params = new URLSearchParams({ company_id: companyId });
  if (workflowId) params.set("workflow_id", workflowId);
  if (status) params.set("status", status);
  return fetchMemoryApi(`/api/v1/workflow/executions?${params.toString()}`);
}

export async function cancelWorkflowExecution(
  companyId: string,
  executionId: string
): Promise<{ status: string }> {
  return fetchMemoryApi(`/api/v1/workflow/executions/${executionId}/cancel?company_id=${companyId}`, {
    method: "POST",
  });
}

export async function resumeWorkflowExecution(
  companyId: string,
  executionId: string
): Promise<{ status: string }> {
  return fetchMemoryApi(`/api/v1/workflow/executions/${executionId}/resume?company_id=${companyId}`, {
    method: "POST",
  });
}

export async function listWorkflowStepExecutions(
  companyId: string,
  executionId: string
): Promise<{ steps: WorkflowStepExecutionSummary[] }> {
  return fetchMemoryApi(`/api/v1/workflow/executions/${executionId}/steps?company_id=${companyId}`);
}

export async function listBudgetAlerts(
  companyId: string,
  capId?: string,
  limit = 50
): Promise<BudgetListResponse<BudgetAlert>> {
  const params = new URLSearchParams({ company_id: companyId, limit: String(limit) });
  if (capId) params.set("cap_id", capId);
  return fetchMemoryApi(`/api/v1/budget/alerts?${params.toString()}`);
}
