import express, { type Express, type Request, type Response } from "express";
import type {
  AgentInfo,
  AgentRole,
  Issue,
  Comment,
  Interaction,
  HeartbeatPing,
  HeartbeatReport,
  MockPaperclipState,
} from "./types.js";

// ── Default fixtures ─────────────────────────────────────────────────

export function defaultAgent(overrides?: Partial<AgentInfo>): AgentInfo {
  return {
    id: "agent-001",
    name: "SoftwareEngineer-1",
    role: "SoftwareEngineer" as AgentRole,
    email: "se1@paperclip.dev",
    companyId: "company-1",
    chainOfCommand: {
      reportsTo: "agent-cto",
      reports: [],
    },
    budget: { limit: 1000, spent: 200, currency: "credits" },
    capacity: { maxConcurrent: 3, current: 1 },
    ...overrides,
  };
}

export function defaultIssue(overrides?: Partial<Issue>): Issue {
  const now = new Date().toISOString();
  return {
    id: "issue-001",
    title: "Fix login bug",
    description: "Users cannot log in with OAuth",
    status: "todo",
    priority: "high",
    assigneeAgentId: "agent-001",
    companyId: "company-1",
    parentId: null,
    goalId: null,
    blockedByIssueIds: [],
    createdAt: now,
    updatedAt: now,
    checkedOutById: null,
    checkedOutAt: null,
    ...overrides,
  };
}

// ── Mock server factory ──────────────────────────────────────────────

export interface MockServerInstance {
  app: Express;
  state: MockPaperclipState;
}

export function createMockPaperclipAPI(
  initialState?: Partial<{
    agents: AgentInfo[];
    issues: Issue[];
    comments: Comment[];
    interactions: Interaction[];
    checkouts: [string, string][];
    staleThresholdMs: number;
    budgetSpendPercent: number;
  }>,
): MockServerInstance {
  const state: MockPaperclipState = {
    agents: new Map(),
    issues: new Map(),
    comments: initialState?.comments ?? [],
    interactions: initialState?.interactions ?? [],
    checkouts: new Map(initialState?.checkouts ?? []),
    staleThresholdMs: initialState?.staleThresholdMs ?? 30 * 60 * 1000, // 30 min
    budgetSpendPercent: initialState?.budgetSpendPercent ?? 20,
    heartbeatReports: [],
    heartbeatPings: {},
  };

  for (const a of initialState?.agents ?? []) {
    state.agents.set(a.id, a);
  }
  for (const i of initialState?.issues ?? []) {
    state.issues.set(i.id, i);
  }

  // Default agents if empty
  if (state.agents.size === 0) {
    const se1 = defaultAgent({
      id: "agent-001",
      name: "SoftwareEngineer-1",
      role: "SoftwareEngineer",
    });
    const se2 = defaultAgent({
      id: "agent-002",
      name: "SoftwareEngineer-2",
      role: "SoftwareEngineer",
      chainOfCommand: { reportsTo: "agent-cto", reports: [] },
    });
    const qa = defaultAgent({
      id: "agent-qa",
      name: "QA-1",
      role: "QA",
    });
    const ceo = defaultAgent({
      id: "agent-ceo",
      name: "CEO",
      role: "CEO",
      chainOfCommand: { reportsTo: null, reports: ["agent-cto"] },
      capacity: { maxConcurrent: 5, current: 2 },
    });
    const cto = defaultAgent({
      id: "agent-cto",
      name: "CTO",
      role: "CTO",
      chainOfCommand: { reportsTo: "agent-ceo", reports: ["agent-001", "agent-002"] },
    });
    state.agents.set(se1.id, se1);
    state.agents.set(se2.id, se2);
    state.agents.set(qa.id, qa);
    state.agents.set(ceo.id, ceo);
    state.agents.set(cto.id, cto);
  }

  const app = express();
  app.use(express.json());

  // Track mutating calls for test inspection
  const mutations: string[] = [];
  (app as any).__mutations = mutations;

  function requireRunId(req: Request, res: Response): boolean {
    const runId = req.headers["x-paperclip-run-id"] as string | undefined;
    if (!runId) {
      res.status(400).json({ error: "Missing X-Paperclip-Run-Id header" });
      return false;
    }
    return true;
  }

  function agentParam(req: Request): string {
    // Allow agent identity via header or query
    return (
      (req.headers["x-paperclip-agent-id"] as string) ??
      (req.query.agentId as string) ??
      "agent-001"
    );
  }

  // ── GET /api/agents/me ──────────────────────────────────────

  app.get("/api/agents/me", (req: Request, res: Response) => {
    const agentId = agentParam(req);
    const agent = state.agents.get(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  });

  // ── GET /api/companies/:companyId/issues ─────────────────────

  app.get("/api/companies/:companyId/issues", (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { assigneeAgentId, status } = req.query;

    let issues = Array.from(state.issues.values()).filter(
      (i) => i.companyId === companyId,
    );

    if (assigneeAgentId && typeof assigneeAgentId === "string") {
      issues = issues.filter((i) => i.assigneeAgentId === assigneeAgentId);
    }

    if (status && typeof status === "string") {
      const statuses = status.split(",");
      issues = issues.filter((i) => statuses.includes(i.status));
    }

    // Sort: in_progress first, then in_review, then todo, then blocked
    const priorityOrder: Record<string, number> = {
      in_progress: 0,
      in_review: 1,
      todo: 2,
      blocked: 3,
    };
    issues.sort(
      (a, b) =>
        (priorityOrder[a.status] ?? 99) - (priorityOrder[b.status] ?? 99),
    );

    res.json(issues);
  });

  // ── POST /api/issues/:id/checkout ───────────────────────────

  app.post("/api/issues/:id/checkout", (req: Request, res: Response) => {
    if (!requireRunId(req, res)) return;

    const { id } = req.params;
    const agentId = agentParam(req);

    const issue = state.issues.get(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    // 409 if already checked out by someone else
    if (issue.checkedOutById && issue.checkedOutById !== agentId) {
      res.status(409).json({
        error: "Issue already checked out",
        checkedOutBy: issue.checkedOutById,
      });
      return;
    }

    const now = new Date().toISOString();
    issue.checkedOutById = agentId;
    issue.checkedOutAt = now;
    issue.status = "in_progress";
    state.checkouts.set(id, agentId);
    state.issues.set(id, issue);
    mutations.push(`checkout:${id}:${agentId}`);

    res.json({ success: true, issue });
  });

  // ── PATCH /api/issues/:id ───────────────────────────────────

  app.patch("/api/issues/:id", (req: Request, res: Response) => {
    if (!requireRunId(req, res)) return;

    const { id } = req.params;
    const issue = state.issues.get(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const updates: Partial<Issue> = req.body;
    if (updates.status) {
      issue.status = updates.status;
      mutations.push(`status:${id}:${updates.status}`);
    }
    if (updates.assigneeAgentId !== undefined) {
      issue.assigneeAgentId = updates.assigneeAgentId;
      mutations.push(`reassign:${id}:${updates.assigneeAgentId}`);
    }
    if (updates.priority) {
      issue.priority = updates.priority;
    }
    if (updates.blockedByIssueIds) {
      issue.blockedByIssueIds = updates.blockedByIssueIds;
    }

    issue.updatedAt = new Date().toISOString();
    state.issues.set(id, issue);

    res.json({ success: true, issue });
  });

  // ── POST /api/issues/:id/comments ───────────────────────────

  app.post("/api/issues/:id/comments", (req: Request, res: Response) => {
    if (!requireRunId(req, res)) return;

    const { id } = req.params;
    const agentId = agentParam(req);

    if (!state.issues.has(id)) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const comment: Comment = {
      id: `comment-${state.comments.length + 1}`,
      issueId: id,
      agentId,
      body: req.body.body ?? "",
      kind: req.body.kind ?? "general",
      createdAt: new Date().toISOString(),
    };
    state.comments.push(comment);
    mutations.push(`comment:${id}:${agentId}`);

    res.status(201).json(comment);
  });

  // ── POST /api/companies/:companyId/issues ────────────────────

  app.post("/api/companies/:companyId/issues", (req: Request, res: Response) => {
    if (!requireRunId(req, res)) return;

    const { companyId } = req.params;
    const now = new Date().toISOString();
    const issue: Issue = {
      id: `issue-${state.issues.size + 1}`,
      ...req.body,
      companyId,
      createdAt: now,
      updatedAt: now,
      checkedOutById: null,
      checkedOutAt: null,
      status: req.body.status ?? "todo",
      blockedByIssueIds: req.body.blockedByIssueIds ?? [],
    };
    state.issues.set(issue.id, issue);
    mutations.push(`create:${issue.id}`);

    res.status(201).json(issue);
  });

  // ── POST /api/issues/:id/interactions ───────────────────────

  app.post("/api/issues/:id/interactions", (req: Request, res: Response) => {
    if (!requireRunId(req, res)) return;

    const { id } = req.params;
    if (!state.issues.has(id)) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const interaction: Interaction = {
      id: `interaction-${state.interactions.length + 1}`,
      issueId: id,
      kind: req.body.kind ?? "request_confirmation",
      continuationPolicy: req.body.continuationPolicy ?? "wake_assignee",
      supersedeOnUserComment: req.body.supersedeOnUserComment ?? false,
      createdAt: new Date().toISOString(),
    };
    state.interactions.push(interaction);
    mutations.push(`interaction:${id}:${interaction.kind}`);

    res.status(201).json(interaction);
  });

  // ── GET /api/heartbeat ──────────────────────────────────────

  app.get("/api/heartbeat", (req: Request, res: Response) => {
    const agentId = agentParam(req);
    const ping: HeartbeatPing =
      state.heartbeatPings[agentId] ?? {
        agentId,
        status: "alive",
        lastCycleAt: new Date().toISOString(),
        currentTaskId: null,
        cycleCount: 0,
      };

    // Check for stale agents
    if (ping.lastCycleAt) {
      const lastCycle = new Date(ping.lastCycleAt).getTime();
      const elapsed = Date.now() - lastCycle;
      if (elapsed > state.staleThresholdMs * 3) {
        ping.status = "dead";
      } else if (elapsed > state.staleThresholdMs * 1.5) {
        ping.status = "degraded";
      }
    }

    res.json(ping);
  });

  // ── POST /api/heartbeat ─────────────────────────────────────

  app.post("/api/heartbeat", (req: Request, res: Response) => {
    if (!requireRunId(req, res)) return;

    const agentId = agentParam(req);
    const report: HeartbeatReport = {
      agentId,
      ...req.body,
    };
    state.heartbeatReports.push(report);

    state.heartbeatPings[agentId] = {
      agentId,
      status: report.errors.length > 0 ? "degraded" : "alive",
      lastCycleAt: new Date().toISOString(),
      currentTaskId: report.issuesProcessed > 0 ? "active" as any : null,
      cycleCount: (state.heartbeatPings[agentId]?.cycleCount ?? 0) + 1,
    };

    mutations.push(`heartbeat:${agentId}`);
    res.status(200).json({ received: true });
  });

  // ── Accessor helpers on the app ─────────────────────────────

  (app as any).__state = state;
  (app as any).__mutations = mutations;

  return {
    app,
    state,
  };
}
