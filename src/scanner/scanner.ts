import { PaperclipIssue, ScanResult, TaskFailure } from '../types';
import { PaperclipClient } from '../api/client';

export interface ScannerDeps {
  client: PaperclipClient;
}

export async function scanTasks(deps: ScannerDeps): Promise<ScanResult> {
  const tasks = await deps.client.getAssignedIssues();

  const staleThreshold = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  const staleTasks = tasks.filter((t) => {
    if (t.status === 'in_progress' || t.status === 'in_review') {
      const age = now - new Date(t.updatedAt).getTime();
      return age > staleThreshold;
    }
    return false;
  });

  const failures: TaskFailure[] = [];

  for (const t of staleTasks) {
    failures.push({
      taskId: t.id,
      reason: t.status === 'in_progress' ? 'stale_in_progress' : 'stuck_in_review',
      severity: 'warning',
      detectedAt: new Date(),
      context: {
        staleMinutes: Math.round((now - new Date(t.updatedAt).getTime()) / 60000),
      },
    });
  }

  for (const t of tasks) {
    if (t.priority === 'critical' && !t.assigneeAgentId) {
      failures.push({
        taskId: t.id,
        reason: 'unassigned_critical',
        severity: 'critical',
        detectedAt: new Date(),
        context: { title: t.title },
      });
    }
  }

  return { tasks, staleTasks, failures };
}
