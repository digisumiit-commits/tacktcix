export interface Company {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  industry: string | null;
  size: string | null;
  vision_statement: string | null;
  selected_models: { providers: ModelProvider[] } | null;
  integrations: Record<string, unknown> | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelProvider {
  provider: string;
  model: string;
  api_key_set: boolean;
}

export interface OnboardingSession {
  id: string;
  company_id: string;
  current_step: number;
  total_steps: number;
  step_data: Record<string, unknown> | null;
  status: string;
  created_at: string;
}

export interface KnowledgeGraph {
  id: string;
  company_id: string;
  nodes: Record<string, KnowledgeNode> | null;
  edges: Record<string, KnowledgeEdge> | null;
  domains: Record<string, Domain> | null;
  capabilities: Record<string, Capability> | null;
}

export interface KnowledgeNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface KnowledgeEdge {
  source: string;
  target: string;
  type: string;
  label: string;
}

export interface Domain {
  name: string;
  relevance_score: number;
  keywords_matched: string[];
}

export interface Capability {
  name: string;
  required: boolean;
  patterns_matched: string[];
}

export interface Constitution {
  id: string;
  company_id: string;
  mission: string | null;
  values: Record<string, unknown> | null;
  principles: Record<string, unknown> | null;
  governance: Record<string, unknown> | null;
  operational_rules: Record<string, unknown> | null;
  full_text: string | null;
}

export interface RoadmapPhase {
  name: string;
  order: number;
  duration_weeks: number;
  objective: string;
  deliverables: string[];
  agent_assignments: Record<string, string[]>;
}

export interface Roadmap {
  id: string;
  company_id: string;
  phases: Record<string, RoadmapPhase> | null;
  milestones: Record<string, unknown> | null;
  timeline: Record<string, unknown> | null;
  priorities: Record<string, string[]> | null;
}

export interface ArchitecturePlan {
  id: string;
  company_id: string;
  tech_stack: Record<string, unknown> | null;
  system_design: Record<string, unknown> | null;
  data_models: Record<string, unknown> | null;
  api_spec: Record<string, unknown> | null;
  infrastructure: Record<string, unknown> | null;
  full_text: string | null;
}

export interface Task {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_role: string | null;
  parent_task_id: string | null;
  dependencies: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface Workflow {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  trigger: Record<string, unknown> | null;
  steps: WorkflowStep[] | null;
  assigned_agents: Record<string, boolean> | null;
  is_active: boolean;
}

export interface WorkflowStep {
  order: number;
  action: string;
  agent: string;
}

export interface OnboardingComplete {
  company: Company;
  knowledge_graph: KnowledgeGraph | null;
  constitution: Constitution | null;
  roadmap: Roadmap | null;
  architecture_plan: ArchitecturePlan | null;
  tasks: Task[];
  workflows: Workflow[];
}

export interface DashboardData {
  company: Company;
  knowledge_graph: KnowledgeGraph | null;
  constitution: Constitution | null;
  roadmap: Roadmap | null;
  architecture_plan: ArchitecturePlan | null;
  tasks: Task[];
  workflows: Workflow[];
  stats: {
    total_tasks: number;
    active_workflows: number;
    onboarding_complete: boolean;
  };
}

export interface ActivityEvent {
  id: string;
  company_id: string;
  type: "task_transition" | "agent_action" | "error" | "workflow_event";
  source: string;
  source_id: string | null;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export type EventTypeFilter = ActivityEvent["type"];

export const EVENT_TYPES: EventTypeFilter[] = [
  "task_transition",
  "agent_action",
  "error",
  "workflow_event",
];

export const ONBOARDING_STEPS = [
  { key: "welcome", label: "Welcome", number: 1 },
  { key: "company_info", label: "Company", number: 2 },
  { key: "vision", label: "Vision", number: 3 },
  { key: "models", label: "AI Models", number: 4 },
  { key: "integrations", label: "Integrations", number: 5 },
  { key: "review", label: "Review", number: 6 },
  { key: "processing", label: "Processing", number: 7 },
  { key: "complete", label: "Complete", number: 8 },
] as const;

export type StepKey = (typeof ONBOARDING_STEPS)[number]["key"];

// ── Budget Types ─────────────────────────────────────────────────────────────

export type BudgetScope = "agent" | "workflow" | "company";
export type BudgetCapStatus = "active" | "inactive";

export interface BudgetCap {
  id: string;
  company_id: string;
  scope: BudgetScope;
  scope_id: string;
  monthly_cents: number;
  status: BudgetCapStatus;
  alert_thresholds: number[];
  notify_agent_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface BudgetCapCreate {
  scope: BudgetScope;
  scope_id: string;
  monthly_cents: number;
  status?: BudgetCapStatus;
  alert_thresholds?: number[];
  notify_agent_ids?: string[];
}

export interface BudgetCapUpdate {
  monthly_cents?: number;
  status?: BudgetCapStatus;
  alert_thresholds?: number[];
  notify_agent_ids?: string[];
}

export interface BudgetState {
  id: string;
  budget_cap_id: string;
  company_id: string;
  period_start: string;
  period_end: string;
  spent_cents: number;
  last_alerted_at: Record<number, string>;
  paused_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BudgetAlert {
  id: string;
  budget_cap_id: string;
  company_id: string;
  threshold: number;
  spent_cents: number;
  monthly_cents: number;
  usage_pct: number;
  action: "alert" | "paused";
  sent_at: string;
}

export interface BudgetCapStatusResponse {
  cap: BudgetCap | null;
  state: BudgetState | null;
  spent_cents: number;
  monthly_cents: number;
  usage_pct: number;
  paused: boolean;
}

export interface BudgetCheckResult {
  checked: boolean;
  alerts_fired: number;
  alerts: BudgetAlert[];
}

export interface BudgetListResponse<T> {
  items: T[];
  total: number;
}
