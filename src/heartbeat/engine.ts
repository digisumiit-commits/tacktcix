import {
  HeartbeatContext,
  HeartbeatResult,
  ScanResult,
  TaskFailure,
  PrioritizedTask,
  ExecutionResult,
  AgentRole,
} from '../types';
import { PaperclipClient } from '../api/client';
import { scanTasks } from '../scanner/scanner';
import { detectFailures } from '../detector/detector';
import { prioritizeTasks, pickTopTask } from '../prioritizer/prioritizer';
import { executeTask } from '../executor/executor';
import { decideSleep } from '../sleeper/sleeper';
import { v4 as uuid } from 'uuid';

export interface HeartbeatEngineConfig {
  client: PaperclipClient;
  agentRole: AgentRole;
  agentId: string;
  companyId: string;
  maxConcurrentTasks: number;
  wakeReason?: string;
  wakeTaskId?: string | null;
  wakeCommentId?: string | null;
}

export async function runHeartbeat(
  config: HeartbeatEngineConfig
): Promise<HeartbeatResult> {
  const runId = uuid();
  const startedAt = new Date();

  // Phase 1: Identity — confirm agent and build context
  const agent = await config.client.getMe();

  const ctx: HeartbeatContext = {
    agent,
    runId,
    wakeReason: (config.wakeReason as HeartbeatContext['wakeReason']) ?? 'scheduled',
    wakeTaskId: config.wakeTaskId ?? null,
    wakeCommentId: config.wakeCommentId ?? null,
    startedAt,
  };

  const log = createLogger(ctx);

  log('Heartbeat started');

  // Phase 2: Scan — fetch assigned tasks
  const scanResult: ScanResult = await scanTasks({ client: config.client });
  log(`Scanned: ${scanResult.tasks.length} tasks, ${scanResult.failures.length} quick failures`);

  // Phase 3: Detect — deep failure analysis
  const deepFailures: TaskFailure[] = await detectFailures(scanResult.tasks, {
    client: config.client,
  });
  const allFailures = [...scanResult.failures, ...deepFailures];
  log(`Detected: ${deepFailures.length} additional failures`);

  // Phase 4: Prioritize — score and rank
  const prioritized: PrioritizedTask[] = prioritizeTasks(scanResult.tasks, ctx.agent.role);
  log(`Prioritized: ${prioritized.length} tasks`);

  // Phase 5: Execute — pick top task and execute
  const maxConcurrent = config.maxConcurrentTasks;
  const executionResults: ExecutionResult[] = [];

  for (let i = 0; i < maxConcurrent; i++) {
    const top = pickTopTask(prioritized, maxConcurrent - i);
    if (!top) break;

    const result = await executeTask(top, {
      client: config.client,
      agentRole: config.agentRole,
      agentId: config.agentId,
      runId,
    });

    executionResults.push(result);

    // If we took a real action (not skip), stop — one action per heartbeat
    if (result.action !== 'skip') break;
  }

  log(`Executed: ${executionResults.length} tasks`);

  // Phase 6: Sleep — decide next wake interval
  const sleepDecision = decideSleep(config.agentRole, scanResult, executionResults);

  const finishedAt = new Date();

  const result: HeartbeatResult = {
    runId,
    agentId: config.agentId,
    startedAt,
    finishedAt,
    scanned: scanResult.tasks.length,
    failuresDetected: allFailures.length,
    prioritized: prioritized.length,
    executed: executionResults,
    summary: buildSummary(scanResult, allFailures, executionResults, sleepDecision),
    nextHeartbeatMs: sleepDecision.sleepMs,
  };

  log(`Heartbeat complete: ${result.summary}`);
  return result;
}

function buildSummary(
  scan: ScanResult,
  failures: TaskFailure[],
  executed: ExecutionResult[],
  sleep: { sleepMs: number; reason: string }
): string {
  const parts: string[] = [];
  parts.push(`${scan.tasks.length} tasks scanned`);
  if (failures.length > 0) {
    const critical = failures.filter((f) => f.severity === 'critical');
    if (critical.length > 0) parts.push(`${critical.length} critical failures`);
    else parts.push(`${failures.length} warnings`);
  }
  for (const r of executed) {
    if (r.action !== 'skip') parts.push(`${r.action} on ${r.taskId}`);
  }
  parts.push(`sleep ${sleep.sleepMs / 1000}s (${sleep.reason})`);
  return parts.join(', ');
}

function createLogger(ctx: HeartbeatContext) {
  return (msg: string) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${ctx.runId.slice(0, 8)}] [${ctx.agent.role}] ${msg}`);
  };
}
