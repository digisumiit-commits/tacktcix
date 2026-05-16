import { SleepDecision, AgentRole, ExecutionResult, ScanResult } from '../types';

const BASE_INTERVALS: Record<AgentRole, number> = {
  ceo: 600_000,   // 10 min — strategic, checks less often
  cto: 300_000,   // 5 min — technical oversight
  developer: 120_000, // 2 min — active coding work
  qa: 180_000,    // 3 min — test cycles
  devops: 300_000, // 5 min — infra stability
  uxdesigner: 600_000, // 10 min — design work
  securityengineer: 600_000, // 10 min — security audits
};

const MIN_SLEEP_MS = 60_000;  // 1 minute minimum
const MAX_SLEEP_MS = 1_800_000; // 30 minutes maximum

export function decideSleep(
  role: AgentRole,
  scanResult: ScanResult,
  executionResults: ExecutionResult[]
): SleepDecision {
  let sleepMs = BASE_INTERVALS[role] ?? 300_000;
  let reason = `default interval for ${role}`;

  // Urgent: critical failures detected — check back faster
  const hasCritical = scanResult.failures.some((f) => f.severity === 'critical');
  if (hasCritical) {
    sleepMs = Math.min(sleepMs, 60_000);
    reason = 'critical failures detected, fast re-check';
  }

  // Busy: we actually did work — stay warm
  const didWork = executionResults.some((r) => r.action === 'work' && r.success);
  if (didWork) {
    sleepMs = Math.min(sleepMs, 120_000);
    reason = 'active work completed, staying warm';
  }

  // Idle: nothing to do — back off
  const nothingDone = executionResults.every((r) => r.action === 'skip');
  const noTasks = scanResult.tasks.length === 0;
  const noFailures = scanResult.failures.length === 0;
  if (nothingDone && noTasks && noFailures) {
    sleepMs = Math.max(sleepMs, 1_200_000); // 20 min minimum idle
    reason = 'no tasks, no failures — idle backoff';
  }

  // Clamp
  sleepMs = Math.max(MIN_SLEEP_MS, Math.min(MAX_SLEEP_MS, sleepMs));

  return {
    sleepMs,
    reason,
    wakeAt: new Date(Date.now() + sleepMs),
  };
}
