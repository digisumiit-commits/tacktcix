// ── Agent ──────────────────────────────────────────────────────────

export type AgentRole =
  | "CEO"
  | "CTO"
  | "SoftwareEngineer"
  | "QA"
  | "UXDesigner"
  | "DevOps"
  | "SecurityEngineer";

export interface AgentInfo {
  id: string;
  name: string;
  role: AgentRole;
  email: string;
  companyId: string;
  chainOfCommand: { reportsTo: string | null; reports: string[] };
  budget: { limit: number; spent: number; currency: string };
  capacity: { maxConcurrent: number; current: number };
}

// ── Issue ───────────────────────────────────────────────────────────

export type IssueStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type IssuePriority = "critical" | "high" | "medium" | "low";

export interface Issue {
  id: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  companyId: string;
  parentId: string | null;
  goalId: string | null;
  blockedByIssueIds: string[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  checkedOutById: string | null;
  checkedOutAt: string | null; // ISO 8601
}

// ── Comment ──────────────────────────────────────────────────────────

export interface Comment {
  id: string;
  issueId: string;
  agentId: string;
  body: string;
  kind: "status_update" | "blocker" | "review" | "general";
  createdAt: string;
}

// ── Interaction ──────────────────────────────────────────────────────

export type InteractionKind =
  | "suggest_tasks"
  | "ask_user_questions"
  | "request_confirmation";

export type ContinuationPolicy = "wake_assignee" | "none";

export interface Interaction {
  id: string;
  issueId: string;
  kind: InteractionKind;
  continuationPolicy: ContinuationPolicy;
  supersedeOnUserComment: boolean;
  createdAt: string;
}

// ── Heartbeat ────────────────────────────────────────────────────────

export interface HeartbeatContext {
  agentId: string;
  companyId: string;
  apiBaseUrl: string;
  wakeReason?: string;
  wakeTaskId?: string;
  wakeCommentId?: string;
  approvalId?: string;
  runId?: string;
}

export interface HeartbeatCycleResult {
  cycleCompleted: boolean;
  step: string;
  action: string;
  issueUpdated?: string;
  commentPosted?: string;
  delegationCreated?: string;
  escalationTriggered?: string;
  dependencyCycleDetected?: string[];
  capacityExceeded: boolean;
  idleBackoffMs: number;
}

// ── HTTP heartbeat endpoint ──────────────────────────────────────────

export interface HeartbeatPing {
  agentId: string;
  status: "alive" | "degraded" | "dead";
  lastCycleAt: string; // ISO 8601
  currentTaskId: string | null;
  cycleCount: number;
}

export interface HeartbeatReport {
  agentId: string;
  cycleCompleted: boolean;
  stepReached: number;
  issuesProcessed: number;
  errors: string[];
  durationMs: number;
}

// ── Mock server state ─────────────────────────────────────────────────

export interface MockPaperclipState {
  agents: Map<string, AgentInfo>;
  issues: Map<string, Issue>;
  comments: Comment[];
  interactions: Interaction[];
  checkouts: Map<string, string>; // issueId → agentId
  staleThresholdMs: number;
  budgetSpendPercent: number;
  heartbeatReports: HeartbeatReport[];
  heartbeatPings: Record<string, HeartbeatPing>;
}
