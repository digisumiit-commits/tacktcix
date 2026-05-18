// ── Pipeline Task Model ──────────────────────────────

export type TaskStatus = 'queued' | 'planning' | 'executing' | 'blocked' | 'review' | 'approved' | 'deployed' | 'failed';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export const TERMINAL_STATES: TaskStatus[] = ['deployed'];

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['planning', 'failed'],
  planning: ['executing', 'failed'],
  executing: ['blocked', 'review', 'failed'],
  blocked: ['executing', 'failed'],
  review: ['approved', 'executing', 'failed'],
  approved: ['deployed', 'failed'],
  deployed: [],
  failed: ['queued'],
};

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  parentId: string | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  slaDeadline: Date | null;
}

// ── Dynamic Reprioritization Constants ──────────────────

/** Maximum SLA urgency boost: worth ~0.5 priority levels */
export const SLA_BOOST_MAX = 50_000_000_000_000;
/** Penalty applied to blocked tasks: worth ~0.3 priority levels */
export const BLOCKED_PENALTY = 30_000_000_000_000;
/** Maximum manual override: worth up to ±5 priority levels */
export const OVERRIDE_BOUND = 500_000_000_000_000;
/** SLA urgency window: tasks within this window get a proportional boost (1 hour) */
export const SLA_WINDOW_MS = 3_600_000;

export const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 100,
  high: 60,
  medium: 30,
  low: 10,
};

export function priorityScore(
  priority: TaskPriority,
  createdAt: Date
): number {
  const weight = PRIORITY_WEIGHTS[priority] ?? 10;
  return weight * 1_000_000_000_000 + (9_999_999_999_999 - createdAt.getTime());
}

// ── Agent & Heartbeat Model ──────────────────────────

export type AgentRole = 'ceo' | 'cto' | 'developer' | 'qa' | 'devops' | 'uxdesigner' | 'securityengineer';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'offline';

export interface Agent {
  id: string;
  role: AgentRole;
  status: AgentStatus;
  companyId: string;
  budgetLimit: number;
  currentSpend: number;
}

export interface HeartbeatContext {
  agent: Agent;
  runId: string;
  wakeReason: 'scheduled' | 'issue_assigned' | 'comment_added' | 'interaction_resolved';
  wakeTaskId: string | null;
  wakeCommentId: string | null;
  startedAt: Date;
}

export interface ScanResult {
  tasks: PaperclipIssue[];
  staleTasks: PaperclipIssue[];
  failures: TaskFailure[];
}

export type FailureReason =
  | 'stale_in_progress'
  | 'stuck_in_review'
  | 'blocked_no_movement'
  | 'dependency_cycle'
  | 'unassigned_critical'
  | 'budget_exceeded'
  | 'agent_offline';

export interface TaskFailure {
  taskId: string;
  reason: FailureReason;
  severity: 'warning' | 'error' | 'critical';
  detectedAt: Date;
  context: Record<string, unknown>;
}

export interface PrioritizedTask extends PaperclipIssue {
  score: number;
  reason: string;
}

export type ExecutionAction =
  | 'work'
  | 'delegate'
  | 'comment'
  | 'status_update'
  | 'unblock'
  | 'escalate'
  | 'skip';

export interface ExecutionResult {
  taskId: string;
  action: ExecutionAction;
  success: boolean;
  summary: string;
  childIssueIds: string[];
  nextHeartbeatMs: number;
}

export interface HeartbeatResult {
  runId: string;
  agentId: string;
  startedAt: Date;
  finishedAt: Date;
  scanned: number;
  failuresDetected: number;
  prioritized: number;
  executed: ExecutionResult[];
  summary: string;
  nextHeartbeatMs: number;
}

export interface SleepDecision {
  sleepMs: number;
  reason: string;
  wakeAt: Date;
}

// ── DB Row shapes (snake_case from Postgres) ─────────

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  parent_id: string | null;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  scheduled_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  sla_deadline: Date | null;
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    parentId: row.parent_id,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    slaDeadline: row.sla_deadline,
  };
}

export interface TaskLogEntry {
  id: string;
  taskId: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
}

// ── Paperclip API Types ──────────────────────────────

export type PaperclipIssueStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export type PaperclipIssuePriority = 'critical' | 'high' | 'medium' | 'low';

export interface PaperclipIssue {
  id: string;
  title: string;
  description: string;
  status: PaperclipIssueStatus;
  priority: PaperclipIssuePriority;
  assigneeAgentId: string | null;
  parentId: string | null;
  goalId: string | null;
  blockedByIssueIds: string[];
  createdAt: string;
  updatedAt: string;
}
