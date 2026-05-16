import { PaperclipIssue, PrioritizedTask, AgentRole } from '../types';

const PRIORITY_WEIGHTS: Record<string, number> = {
  critical: 100,
  high: 60,
  medium: 30,
  low: 10,
};

const STATUS_WEIGHTS: Record<string, number> = {
  in_progress: 1.5,
  in_review: 1.2,
  blocked: 0.5,
  todo: 1.0,
};

export function prioritizeTasks(
  issues: PaperclipIssue[],
  role: AgentRole
): PrioritizedTask[] {
  const scored: PrioritizedTask[] = issues.map((issue) => {
    let score = PRIORITY_WEIGHTS[issue.priority] ?? 10;
    score *= STATUS_WEIGHTS[issue.status] ?? 1.0;

    // In-progress work keeps momentum
    if (issue.status === 'in_progress') {
      score += 30;
    }

    // CTO prioritizes blocked tasks to unblock the team
    if (role === 'cto' && issue.status === 'blocked') {
      score += 20;
    }

    // QA prioritizes in_review (needs verification)
    if (role === 'qa' && issue.status === 'in_review') {
      score += 40;
    }

    // Critical unassigned tasks get a boost for CTO/CEO to triage
    if ((role === 'cto' || role === 'ceo') && issue.priority === 'critical' && !issue.assigneeAgentId) {
      score += 50;
    }

    return {
      ...issue,
      score,
      reason: `priority=${issue.priority} status=${issue.status} role=${role}`,
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}

export function pickTopTask(
  prioritized: PrioritizedTask[],
  maxConcurrent: number = 1
): PrioritizedTask | null {
  const actionable = prioritized.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled'
  );
  if (actionable.length === 0) return null;

  const inProgress = actionable.filter((t) => t.status === 'in_progress').length;
  if (inProgress >= maxConcurrent) {
    return null; // Already at capacity
  }

  return actionable[0];
}
