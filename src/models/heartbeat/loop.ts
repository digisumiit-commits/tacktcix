import type {
  AgentInfo,
  Issue,
  Comment,
  HeartbeatContext,
  HeartbeatCycleResult,
  HeartbeatReport,
  IssueStatus,
  Interaction,
} from "./types.js";

// ── HTTP helper ──────────────────────────────────────────────────────

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function apiRequest(
  baseUrl: string,
  options: RequestOptions,
): Promise<{ status: number; data: any }> {
  const url = new URL(options.path, baseUrl);
  const body = options.body ? JSON.stringify(options.body) : undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (body) {
    headers["Content-Length"] = Buffer.byteLength(body).toString();
  }

  const response = await fetch(url.toString(), {
    method: options.method,
    headers,
    body,
  });

  let data: any;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: response.status, data };
}

// ── Priority scoring ─────────────────────────────────────────────────

// Status is the primary sort dimension — weights dominate priority scores
const STATUS_PRIORITY: Record<string, number> = {
  in_progress: 1000,
  in_review: 500,
  todo: 100,
  blocked: 0,
};

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 50,
  medium: 20,
  low: 5,
};

function scoreIssue(issue: Issue, wakeTaskId?: string): number {
  let score = STATUS_PRIORITY[issue.status] ?? 0;
  score += PRIORITY_SCORE[issue.priority] ?? 0;
  if (wakeTaskId && issue.id === wakeTaskId) score += 10_000;
  // Stale issues (not updated in 30+ min) get a boost
  if (issue.status === "in_progress") {
    const elapsed = Date.now() - new Date(issue.updatedAt).getTime();
    if (elapsed > 30 * 60 * 1000) score += 30;
  }
  return score;
}

// ── Dependency cycle detection ───────────────────────────────────────

export function detectDependencyCycles(issues: Map<string, Issue>): string[][] {
  const cycles: string[][] = [];

  for (const [id, issue] of issues) {
    if (!issue.blockedByIssueIds || issue.blockedByIssueIds.length === 0) continue;

    const visited = new Set<string>();
    const path: string[] = [];

    function dfs(currentId: string): boolean {
      if (path.includes(currentId)) {
        const cycleStart = path.indexOf(currentId);
        cycles.push([...path.slice(cycleStart), currentId]);
        return true;
      }
      if (visited.has(currentId)) return false;

      visited.add(currentId);
      path.push(currentId);

      const current = issues.get(currentId);
      if (current?.blockedByIssueIds) {
        for (const blockedById of current.blockedByIssueIds) {
          if (dfs(blockedById)) return true;
        }
      }

      path.pop();
      return false;
    }

    dfs(id);
  }

  return cycles;
}

// ── Heartbeat loop ───────────────────────────────────────────────────

export async function runHeartbeatCycle(
  ctx: HeartbeatContext,
): Promise<HeartbeatCycleResult> {
  const result: HeartbeatCycleResult = {
    cycleCompleted: false,
    step: "start",
    action: "beginning heartbeat cycle",
    capacityExceeded: false,
    idleBackoffMs: 0,
  };

  const runId = ctx.runId ?? `run-${Date.now()}`;
  const headers = {
    "X-Paperclip-Run-Id": runId,
    "X-Paperclip-Agent-Id": ctx.agentId,
  };

  try {
    // ── Step 1: Identity ──────────────────────────────────────

    result.step = "identity";
    const agentRes = await apiRequest(ctx.apiBaseUrl, {
      method: "GET",
      path: "/api/agents/me",
      headers,
    });

    if (agentRes.status !== 200) {
      result.action = `identity check failed: ${agentRes.status}`;
      return result;
    }

    const agent: AgentInfo = agentRes.data;
    result.action = `confirmed identity as ${agent.role} (${agent.name})`;

    // ── Step 2: Local Planning ────────────────────────────────

    result.step = "planning";
    // Local planning is handled by the harness; skip for integration tests.

    // ── Step 3: Approval Follow-Up ────────────────────────────

    result.step = "approval";
    if (ctx.approvalId) {
      result.action = `checking approval ${ctx.approvalId}`;
      // Approval handling is delegated to the harness/skill
    }

    // ── Step 4: Get Assignments ───────────────────────────────

    result.step = "assignments";
    const issuesRes = await apiRequest(ctx.apiBaseUrl, {
      method: "GET",
      path: `/api/companies/${ctx.companyId}/issues?assigneeAgentId=${ctx.agentId}&status=todo,in_progress,in_review,blocked`,
      headers,
    });

    const issues: Issue[] = issuesRes.status === 200 ? issuesRes.data : [];

    if (issues.length === 0) {
      result.step = "idle";
      result.action = "no assignments found";
      result.idleBackoffMs = 60_000; // 1 minute base backoff
      result.cycleCompleted = true;
      return result;
    }

    // Check for dependency cycles
    const issueMap = new Map(issues.map((i) => [i.id, i]));
    const cycles = detectDependencyCycles(issueMap);
    if (cycles.length > 0) {
      result.dependencyCycleDetected = cycles[0];
      result.step = "blocked";
      result.action = `dependency cycle detected: ${cycles[0].join(" → ")}`;
    }

    // Prioritize
    issues.sort((a, b) => scoreIssue(b, ctx.wakeTaskId) - scoreIssue(a, ctx.wakeTaskId));
    const topIssue = issues[0];

    // Capacity gating
    if (agent.capacity.current >= agent.capacity.maxConcurrent) {
      result.capacityExceeded = true;
      result.step = "capacity_gate";
      result.action = `at capacity (${agent.capacity.current}/${agent.capacity.maxConcurrent})`;
      result.cycleCompleted = true;
      return result;
    }

    // Budget gate (CEO-specific)
    if (agent.role === "CEO" && agent.budget.spent / agent.budget.limit > 0.8) {
      if (topIssue.priority !== "critical") {
        result.action = "budget threshold exceeded, skipping non-critical task";
        result.cycleCompleted = true;
        return result;
      }
    }

    // ── Step 5: Checkout and Work ─────────────────────────────

    result.step = "checkout";

    // Only checkout if not already checked out
    if (!topIssue.checkedOutById || topIssue.checkedOutById === ctx.agentId) {
      // If top issue is already checked out by us, skip checkout
    }

    const checkoutRes = await apiRequest(ctx.apiBaseUrl, {
      method: "POST",
      path: `/api/issues/${topIssue.id}/checkout`,
      headers,
    });

    if (checkoutRes.status === 409) {
      result.action = `checkout conflict on ${topIssue.id} — belongs to another agent`;
      result.cycleCompleted = true;
      return result;
    }

    if (checkoutRes.status !== 200) {
      result.action = `checkout failed: ${checkoutRes.status}`;
      return result;
    }

    // Simulate work execution
    result.step = "execute";
    const executeResult = await executeWork(agent, topIssue, ctx, headers);
    result.issueUpdated = topIssue.id;
    result.action = executeResult;

    // ── Step 6: Delegation ────────────────────────────────────

    result.step = "delegation";
    // Delegation is triggered by the agent's judgment during executeWork

    // ── Step 7: Fact Extraction ───────────────────────────────

    result.step = "facts";
    // Fact extraction is handled by the harness; skip for integration tests.

    // ── Step 8: Exit / Heartbeat Report ────────────────────────

    result.step = "exit";

    const report: HeartbeatReport = {
      agentId: ctx.agentId,
      cycleCompleted: true,
      stepReached: 8,
      issuesProcessed: 1,
      errors: [],
      durationMs: 0,
    };

    await apiRequest(ctx.apiBaseUrl, {
      method: "POST",
      path: "/api/heartbeat",
      headers,
      body: report,
    });

    result.cycleCompleted = true;
  } catch (err: any) {
    result.action = `heartbeat error: ${err.message}`;
  }

  return result;
}

// ── Work execution ───────────────────────────────────────────────────

async function executeWork(
  agent: AgentInfo,
  issue: Issue,
  ctx: HeartbeatContext,
  headers: Record<string, string>,
): Promise<string> {
  // Post a status comment
  await apiRequest(ctx.apiBaseUrl, {
    method: "POST",
    path: `/api/issues/${issue.id}/comments`,
    headers,
    body: {
      body: `${agent.role} working on: ${issue.title}`,
      kind: "status_update",
    },
  });

  // Determine next status based on role
  let nextStatus: IssueStatus;
  switch (agent.role) {
    case "SoftwareEngineer":
    case "DevOps":
      // Engineers move to in_review if task has review requirements
      nextStatus = "in_review";
      break;
    case "QA":
      // QA resolves tasks
      nextStatus = "done";
      break;
    case "CEO":
      // CEO typically delegates or closes
      nextStatus = "done";
      break;
    case "CTO":
      nextStatus = "in_review";
      break;
    default:
      nextStatus = "in_review";
  }

  // Update issue status
  await apiRequest(ctx.apiBaseUrl, {
    method: "PATCH",
    path: `/api/issues/${issue.id}`,
    headers,
    body: { status: nextStatus },
  });

  return `${agent.role} completed work on ${issue.id}, status → ${nextStatus}`;
}

// ── Stale task escalation ────────────────────────────────────────────

export async function escalateStaleTask(
  apiBaseUrl: string,
  issue: Issue,
  agent: AgentInfo,
  runId: string,
): Promise<{ escalated: boolean; comment?: Comment }> {
  const headers = {
    "X-Paperclip-Run-Id": runId,
    "X-Paperclip-Agent-Id": agent.id,
  };

  const elapsed = Date.now() - new Date(issue.updatedAt).getTime();
  if (elapsed < 30 * 60 * 1000) {
    return { escalated: false };
  }

  const commentRes = await apiRequest(apiBaseUrl, {
    method: "POST",
    path: `/api/issues/${issue.id}/comments`,
    headers,
    body: {
      body: `⚠️ Task stale for ${Math.round(elapsed / 60000)}min. Escalating to ${agent.chainOfCommand.reportsTo ?? "board"}.`,
      kind: "blocker",
    },
  });

  // Reassign to manager if possible
  if (agent.chainOfCommand.reportsTo) {
    await apiRequest(apiBaseUrl, {
      method: "PATCH",
      path: `/api/issues/${issue.id}`,
      headers,
      body: { assigneeAgentId: agent.chainOfCommand.reportsTo },
    });
  }

  return { escalated: true, comment: commentRes.data };
}

// ── Idle backoff calculator ──────────────────────────────────────────

const BACKOFF_SCHEDULE = [
  60_000,    // 1 min
  120_000,   // 2 min
  300_000,   // 5 min
  600_000,   // 10 min
  900_000,   // 15 min
  1_800_000, // 30 min
];

export function getIdleBackoff(consecutiveIdleCycles: number): number {
  const idx = Math.min(consecutiveIdleCycles, BACKOFF_SCHEDULE.length - 1);
  return BACKOFF_SCHEDULE[idx];
}
