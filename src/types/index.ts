// ── Task Orchestration Engine types ──

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'executing'
  | 'blocked'
  | 'review'
  | 'approved'
  | 'deployed'
  | 'failed';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

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
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
}

export interface TaskLog {
  id: string;
  taskId: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['planning', 'failed'],
  planning: ['executing', 'failed'],
  executing: ['blocked', 'review', 'failed'],
  blocked: ['executing', 'failed'],
  review: ['approved', 'executing', 'failed'],
  approved: ['deployed', 'failed'],
  deployed: ['failed'],
  failed: ['queued'],
};

export const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

export const TERMINAL_STATES: TaskStatus[] = ['deployed'];

export function priorityScore(priority: TaskPriority, createdAt: Date): number {
  const base = PRIORITY_WEIGHTS[priority] * 1_000_000_000_000;
  const timeComponent = createdAt.getTime();
  return base + (9_999_999_999_999 - timeComponent);
}

// Database row types
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

// ── Heartbeat Engine types (used by scanner/detector/executor/prioritizer/sleeper) ──

export type HeartbeatIssueStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type HeartbeatIssuePriority = 'critical' | 'high' | 'medium' | 'low';

export interface HeartbeatIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status: HeartbeatIssueStatus;
  priority: HeartbeatIssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockedByIssueIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type AgentRole =
  | 'ceo'
  | 'cto'
  | 'developer'
  | 'qa'
  | 'devops'
  | 'uxdesigner'
  | 'securityengineer';

export type ExecutionAction =
  | 'delegate'
  | 'escalate'
  | 'unblock'
  | 'work'
  | 'status_update'
  | 'comment'
  | 'skip';

export type FailureReason =
  | 'stale_in_progress'
  | 'stuck_in_review'
  | 'blocked_no_movement'
  | 'dependency_cycle'
  | 'unassigned_critical';

export interface TaskFailure {
  taskId: string;
  reason: FailureReason;
  severity: 'warning' | 'error' | 'critical';
  detectedAt: Date;
  context: Record<string, unknown>;
}

export interface PrioritizedTask extends HeartbeatIssue {
  score: number;
  reason: string;
}

export interface ExecutionResult {
  taskId: string;
  action: ExecutionAction;
  success: boolean;
  summary: string;
  childIssueIds: string[];
  nextHeartbeatMs: number;
}

export interface ScanResult {
  tasks: HeartbeatIssue[];
  staleTasks: HeartbeatIssue[];
  failures: TaskFailure[];
}

export interface SleepDecision {
  sleepMs: number;
  reason: string;
  wakeAt: Date;
}

export interface HeartbeatContext {
  agent: { id: string; role: AgentRole; companyId: string };
  runId: string;
  wakeReason: 'scheduled' | 'issue_assigned' | 'issue_commented' | 'issue_comment_mentioned' | 'issue_blockers_resolved' | 'issue_children_completed' | 'approval_resolved';
  wakeTaskId: string | null;
  wakeCommentId: string | null;
  startedAt: Date;
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
