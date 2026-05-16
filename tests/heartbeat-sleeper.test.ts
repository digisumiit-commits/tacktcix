import { describe, it, expect } from 'vitest';
import { decideSleep } from '../src/sleeper/sleeper';
import { ScanResult, ExecutionResult } from '../src/types';

function emptyScan(): ScanResult {
  return { tasks: [], staleTasks: [], failures: [] };
}

function emptyExec(): ExecutionResult[] {
  return [];
}

describe('Heartbeat Sleeper', () => {
  it('returns base interval for developer', () => {
    // Need a task to avoid idle backoff
    const scan: ScanResult = {
      tasks: [{ id: '1', title: '', description: '', status: 'todo', priority: 'medium', assigneeAgentId: null, parentId: null, goalId: null, blockedByIssueIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      staleTasks: [],
      failures: [],
    };
    const decision = decideSleep('developer', scan, emptyExec());
    expect(decision.sleepMs).toBe(120_000);
  });

  it('shortens sleep on critical failures', () => {
    const scan: ScanResult = {
      tasks: [],
      staleTasks: [],
      failures: [
        {
          taskId: 't1',
          reason: 'unassigned_critical',
          severity: 'critical',
          detectedAt: new Date(),
          context: {},
        },
      ],
    };
    const decision = decideSleep('ceo', scan, emptyExec());
    expect(decision.sleepMs).toBe(60_000);
  });

  it('shortens sleep after active work', () => {
    const exec: ExecutionResult[] = [
      {
        taskId: 't1',
        action: 'work',
        success: true,
        summary: 'did work',
        childIssueIds: [],
        nextHeartbeatMs: 300_000,
      },
    ];
    const decision = decideSleep('cto', emptyScan(), exec);
    expect(decision.sleepMs).toBe(120_000); // stay warm
  });

  it('backs off when idle with nothing to do', () => {
    const exec: ExecutionResult[] = [
      { taskId: 't1', action: 'skip', success: true, summary: '', childIssueIds: [], nextHeartbeatMs: 0 },
    ];
    const decision = decideSleep('devops', emptyScan(), exec);
    // idle backoff
    expect(decision.sleepMs).toBeGreaterThanOrEqual(300_000);
  });

  it('extends sleep when completely idle', () => {
    // Nothing done, no tasks, no failures — should back off
    const exec: ExecutionResult[] = [
      {
        taskId: 't1',
        action: 'skip',
        success: true,
        summary: 'skipped',
        childIssueIds: [],
        nextHeartbeatMs: 300_000,
      },
    ];
    const scan: ScanResult = { tasks: [], staleTasks: [], failures: [] };
    const decision = decideSleep('ceo', scan, exec);
    expect(decision.sleepMs).toBeGreaterThanOrEqual(600_000); // idle backoff
  });

  it('clamps to minimum sleep', () => {
    // Even with critical failure, don't go below MIN_SLEEP
    const scan: ScanResult = {
      tasks: [],
      staleTasks: [],
      failures: [
        {
          taskId: 't1',
          reason: 'unassigned_critical',
          severity: 'critical',
          detectedAt: new Date(),
          context: {},
        },
      ],
    };
    const decision = decideSleep('developer', scan, emptyExec());
    expect(decision.sleepMs).toBeGreaterThanOrEqual(60_000);
  });

  it('clamps to maximum sleep', () => {
    const decision = decideSleep('ceo', emptyScan(), emptyExec());
    // CEO idle base = 600_000, extended to 1_200_000 for idle — still below MAX
    expect(decision.sleepMs).toBeLessThanOrEqual(1_800_000);
  });
});
