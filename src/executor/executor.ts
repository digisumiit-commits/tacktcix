import {
  PrioritizedTask,
  ExecutionResult,
  ExecutionAction,
  AgentRole,
} from '../types';
import { PaperclipClient } from '../api/client';

export interface ExecutorDeps {
  client: PaperclipClient;
  agentRole: AgentRole;
  agentId: string;
  runId: string;
}

const ROLE_ACTIONS: Record<AgentRole, ExecutionAction[]> = {
  ceo: ['delegate', 'escalate', 'unblock', 'skip'],
  cto: ['delegate', 'unblock', 'work', 'status_update', 'escalate'],
  developer: ['work', 'comment', 'skip'],
  qa: ['work', 'comment', 'skip'],
  devops: ['work', 'unblock', 'comment'],
  uxdesigner: ['work', 'comment', 'skip'],
  securityengineer: ['work', 'comment', 'escalate'],
};

const DEFAULT_NEXT_HEARTBEAT_MS = 300_000; // 5 minutes

export async function executeTask(
  task: PrioritizedTask,
  deps: ExecutorDeps
): Promise<ExecutionResult> {
  const allowedActions = ROLE_ACTIONS[deps.agentRole] ?? ['skip'];
  const action = determineAction(task, deps.agentRole, allowedActions);

  let success = false;
  let summary = '';
  const childIssueIds: string[] = [];

  switch (action) {
    case 'delegate':
      summary = await handleDelegate(task, deps);
      success = true;
      break;

    case 'unblock':
      success = await handleUnblock(task, deps);
      summary = success
        ? `Unblocked by commenting on blockers`
        : `Failed to unblock`;
      break;

    case 'work':
      summary = `Task ${task.id} ready for work execution in workspace`;
      success = await checkoutIfNeeded(task, deps);
      break;

    case 'status_update':
      summary = `Stale task ${task.id} — posted progress inquiry`;
      await deps.client.updateIssue(task.id, deps.runId, {
        comment: 'Heartbeat: this task appears stale. Requesting status update.',
      });
      success = true;
      break;

    case 'escalate':
      summary = `Escalated ${task.id} — needs human or parent intervention`;
      success = true;
      break;

    case 'skip':
    default:
      summary = `Skipped ${task.id} — outside role scope or already at capacity`;
      success = true;
      break;
  }

  return {
    taskId: task.id,
    action,
    success,
    summary,
    childIssueIds,
    nextHeartbeatMs: DEFAULT_NEXT_HEARTBEAT_MS,
  };
}

async function checkoutIfNeeded(
  task: PrioritizedTask,
  deps: ExecutorDeps
): Promise<boolean> {
  if (task.status === 'todo') {
    const result = await deps.client.checkoutIssue(task.id, deps.runId);
    return result.claimed;
  }
  return task.status === 'in_progress';
}

async function handleDelegate(
  task: PrioritizedTask,
  deps: ExecutorDeps
): Promise<string> {
  return `Delegation path prepared for ${task.id} — agent will create child issues`;
}

async function handleUnblock(
  task: PrioritizedTask,
  deps: ExecutorDeps
): Promise<boolean> {
  for (const blockerId of task.blockedByIssueIds) {
    try {
      await deps.client.updateIssue(blockerId, deps.runId, {
        comment: `Heartbeat check: this blocks ${task.id}. Please update status.`,
      });
    } catch {
      continue;
    }
  }
  return true;
}

function determineAction(
  task: PrioritizedTask,
  role: AgentRole,
  allowed: ExecutionAction[]
): ExecutionAction {
  if (role === 'ceo') return 'delegate';

  if (role === 'cto') {
    if (task.status === 'blocked' && task.blockedByIssueIds.length > 0) return 'unblock';
    if (task.priority === 'critical') return 'work';
    return 'delegate';
  }

  if (role === 'developer') {
    if (task.status === 'in_progress' || task.status === 'todo') return 'work';
    return 'skip';
  }

  if (role === 'qa') {
    if (task.status === 'in_review' || task.status === 'todo') return 'work';
    return 'skip';
  }

  if (role === 'devops') {
    if (task.status === 'in_progress' || task.status === 'todo') return 'work';
    return 'skip';
  }

  return allowed[0] ?? 'skip';
}
