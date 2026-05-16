import { PaperclipIssue, TaskFailure, FailureReason } from '../types';
import { PaperclipClient } from '../api/client';

export interface DetectorDeps {
  client: PaperclipClient;
}

export async function detectFailures(
  issues: PaperclipIssue[],
  deps: DetectorDeps
): Promise<TaskFailure[]> {
  const failures: TaskFailure[] = [];
  const now = Date.now();
  const criticalAge = 24 * 60 * 60 * 1000; // 24 hours
  const warningAge = 4 * 60 * 60 * 1000; // 4 hours

  for (const issue of issues) {
    const age = now - new Date(issue.updatedAt).getTime();

    // Stale in_progress — nothing moved in 4+ hours
    if (issue.status === 'in_progress' && age > warningAge) {
      failures.push(createFailure(issue.id, 'stale_in_progress',
        age > criticalAge ? 'critical' : 'warning', { ageHours: Math.round(age / 3600000) }));
    }

    // Stuck in_review — review blocked for 24+ hours
    if (issue.status === 'in_review' && age > criticalAge) {
      failures.push(createFailure(issue.id, 'stuck_in_review', 'error',
        { ageHours: Math.round(age / 3600000) }));
    }

    // Blocked with no movement and no blockers specified
    if (issue.status === 'blocked' && age > criticalAge && issue.blockedByIssueIds.length === 0) {
      failures.push(createFailure(issue.id, 'blocked_no_movement', 'warning',
        { ageHours: Math.round(age / 3600000) }));
    }

    // Dependency cycle detection
    if (issue.status === 'blocked' && issue.blockedByIssueIds.length > 0) {
      for (const blockerId of issue.blockedByIssueIds) {
        try {
          const blocker = await deps.client.getIssue(blockerId);
          if (blocker.blockedByIssueIds.includes(issue.id)) {
            failures.push(createFailure(issue.id, 'dependency_cycle', 'critical',
              { cycleWith: blockerId }));
          }
        } catch {
          // Blocker not found — not a cycle, just missing
        }
      }
    }
  }

  return failures;
}

function createFailure(
  taskId: string,
  reason: FailureReason,
  severity: 'warning' | 'error' | 'critical',
  context: Record<string, unknown>
): TaskFailure {
  return { taskId, reason, severity, detectedAt: new Date(), context };
}
