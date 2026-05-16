import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import type { Express } from "express";
import {
  createMockPaperclipAPI,
  defaultAgent,
  defaultIssue,
  runHeartbeatCycle,
  detectDependencyCycles,
  escalateStaleTask,
  getIdleBackoff,
} from "../src/heartbeat/index.js";
import type {
  AgentInfo,
  Issue,
  MockPaperclipState,
} from "../src/heartbeat/index.js";

// ── Helpers ───────────────────────────────────────────────────────────

interface TestFixture {
  app: Express;
  state: MockPaperclipState;
  server: Server;
  baseUrl: string;
}

function startMockServer(
  initialState?: Parameters<typeof createMockPaperclipAPI>[0],
): Promise<TestFixture> {
  return new Promise((resolve) => {
    const { app, state } = createMockPaperclipAPI(initialState);
    const server = createHttpServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ app, state, server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function teardown(fixture: TestFixture) {
  fixture.server.close();
}

function makeRunId() {
  return `run-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Full cycle tests ──────────────────────────────────────────────────

describe("Heartbeat E2E — full cycle per agent role", () => {
  let fix: TestFixture;

  afterEach(() => {
    if (fix) teardown(fix);
  });

  const now = new Date().toISOString();

  describe("SoftwareEngineer", () => {
    beforeEach(async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-se-1",
            name: "SoftwareEngineer-1",
            role: "SoftwareEngineer",
            capacity: { maxConcurrent: 3, current: 0 },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-1",
            title: "Fix OAuth login bug",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-se-1",
            companyId: "company-1",
          }),
        ],
      });
    });

    it("completes full scan→detect→prioritize→execute→sleep cycle", async () => {
      const result = await runHeartbeatCycle({
        agentId: "agent-se-1",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(result.step).toBe("exit");
      expect(result.action).toContain("SoftwareEngineer completed work");
      expect(result.issueUpdated).toBe("issue-1");

      // Verify issue was checked out and status advanced to in_review
      const issue = fix.state.issues.get("issue-1");
      expect(issue).toBeDefined();
      expect(issue!.status).toBe("in_review");
      expect(issue!.checkedOutById).toBe("agent-se-1");

      // Verify a status comment was posted
      const comments = fix.state.comments.filter((c) => c.issueId === "issue-1");
      expect(comments.length).toBeGreaterThanOrEqual(1);
      expect(comments[0].kind).toBe("status_update");

      // Verify heartbeat report was recorded
      expect(fix.state.heartbeatReports.length).toBe(1);
      expect(fix.state.heartbeatReports[0].cycleCompleted).toBe(true);
      expect(fix.state.heartbeatReports[0].agentId).toBe("agent-se-1");
    });

    it("prioritizes in_progress tasks over todo", async () => {
      // Add an in_progress issue
      fix.state.issues.set(
        "issue-2",
        defaultIssue({
          id: "issue-2",
          title: "Higher priority task",
          status: "in_progress",
          priority: "low",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
        }),
      );

      const result = await runHeartbeatCycle({
        agentId: "agent-se-1",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.issueUpdated).toBe("issue-2");
    });

    it("prioritizes wake_task_id above all else", async () => {
      fix.state.issues.set(
        "issue-2",
        defaultIssue({
          id: "issue-2",
          title: "Wake target",
          status: "todo",
          priority: "low",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
        }),
      );

      fix.state.issues.set(
        "issue-3",
        defaultIssue({
          id: "issue-3",
          title: "High priority distraction",
          status: "in_progress",
          priority: "critical",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
        }),
      );

      const result = await runHeartbeatCycle({
        agentId: "agent-se-1",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        wakeTaskId: "issue-2",
        runId: makeRunId(),
      });

      expect(result.issueUpdated).toBe("issue-2");
    });
  });

  describe("QA", () => {
    beforeEach(async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-qa-1",
            name: "QA-1",
            role: "QA",
            capacity: { maxConcurrent: 2, current: 0 },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-qa",
            title: "Verify OAuth fix",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-qa-1",
            companyId: "company-1",
          }),
        ],
      });
    });

    it("QA resolves tasks to done instead of in_review", async () => {
      const result = await runHeartbeatCycle({
        agentId: "agent-qa-1",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(result.issueUpdated).toBe("issue-qa");

      const issue = fix.state.issues.get("issue-qa");
      expect(issue!.status).toBe("done");
    });

    it("posts status update comment during execution", async () => {
      await runHeartbeatCycle({
        agentId: "agent-qa-1",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      const comments = fix.state.comments.filter((c) => c.issueId === "issue-qa");
      expect(comments.length).toBeGreaterThanOrEqual(1);
      expect(comments[0].body).toContain("QA working on");
    });
  });

  describe("CEO", () => {
    it("CEO delegates and resolves tasks", async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-ceo",
            name: "CEO",
            role: "CEO",
            capacity: { maxConcurrent: 5, current: 0 },
            budget: { limit: 1000, spent: 200, currency: "credits" },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-ceo",
            title: "Strategic review",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-ceo",
            companyId: "company-1",
          }),
        ],
      });

      const result = await runHeartbeatCycle({
        agentId: "agent-ceo",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(result.issueUpdated).toBe("issue-ceo");
      expect(fix.state.issues.get("issue-ceo")!.status).toBe("done");
    });

    it("skips non-critical tasks when budget exceeds 80%", async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-ceo",
            name: "CEO",
            role: "CEO",
            capacity: { maxConcurrent: 5, current: 0 },
            budget: { limit: 1000, spent: 900, currency: "credits" },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-ceo-low",
            title: "Low priority",
            status: "todo",
            priority: "low",
            assigneeAgentId: "agent-ceo",
            companyId: "company-1",
          }),
        ],
      });

      const result = await runHeartbeatCycle({
        agentId: "agent-ceo",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(result.action).toContain("budget threshold");
      // Issue should NOT have been checked out
      expect(fix.state.issues.get("issue-ceo-low")!.status).toBe("todo");
    });

    it("processes critical tasks even when budget exceeds 80%", async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-ceo",
            name: "CEO",
            role: "CEO",
            capacity: { maxConcurrent: 5, current: 0 },
            budget: { limit: 1000, spent: 900, currency: "credits" },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-ceo-critical",
            title: "Security breach",
            status: "todo",
            priority: "critical",
            assigneeAgentId: "agent-ceo",
            companyId: "company-1",
          }),
        ],
      });

      const result = await runHeartbeatCycle({
        agentId: "agent-ceo",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(result.issueUpdated).toBe("issue-ceo-critical");
    });
  });

  describe("CTO", () => {
    beforeEach(async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-cto",
            name: "CTO",
            role: "CTO",
            capacity: { maxConcurrent: 3, current: 0 },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-cto",
            title: "Architecture review",
            status: "todo",
            priority: "high",
            assigneeAgentId: "agent-cto",
            companyId: "company-1",
          }),
        ],
      });
    });

    it("CTO moves tasks to in_review after execution", async () => {
      const result = await runHeartbeatCycle({
        agentId: "agent-cto",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(fix.state.issues.get("issue-cto")!.status).toBe("in_review");
    });
  });

  describe("DevOps", () => {
    beforeEach(async () => {
      fix = await startMockServer({
        agents: [
          defaultAgent({
            id: "agent-devops",
            name: "DevOps-1",
            role: "DevOps",
            capacity: { maxConcurrent: 2, current: 0 },
          }),
        ],
        issues: [
          defaultIssue({
            id: "issue-do",
            title: "Deploy pipeline optimization",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-devops",
            companyId: "company-1",
          }),
        ],
      });
    });

    it("DevOps moves tasks to in_review after execution", async () => {
      const result = await runHeartbeatCycle({
        agentId: "agent-devops",
        companyId: "company-1",
        apiBaseUrl: fix.baseUrl,
        runId: makeRunId(),
      });

      expect(result.cycleCompleted).toBe(true);
      expect(fix.state.issues.get("issue-do")!.status).toBe("in_review");
    });
  });
});

// ── Stale task escalation ─────────────────────────────────────────────

describe("Heartbeat E2E — stale task escalation", () => {
  let fix: TestFixture;

  afterEach(() => {
    if (fix) teardown(fix);
  });

  it("escalates in_progress task that has been stale for over 30 minutes", async () => {
    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();

    fix = await startMockServer({
      agents: [
        defaultAgent({
          id: "agent-se-1",
          name: "SoftwareEngineer-1",
          role: "SoftwareEngineer",
          chainOfCommand: { reportsTo: "agent-cto", reports: [] },
        }),
        defaultAgent({
          id: "agent-cto",
          name: "CTO",
          role: "CTO",
        }),
      ],
      issues: [
        defaultIssue({
          id: "issue-stale",
          title: "Stale bug fix",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
          checkedOutById: "agent-se-1",
          updatedAt: staleTime,
        }),
      ],
    });

    const staleIssue = fix.state.issues.get("issue-stale")!;
    const agent = fix.state.agents.get("agent-se-1")!;

    const result = await escalateStaleTask(
      fix.baseUrl,
      staleIssue,
      agent,
      makeRunId(),
    );

    expect(result.escalated).toBe(true);

    // Should have posted a blocker comment
    const comments = fix.state.comments.filter((c) => c.issueId === "issue-stale");
    const blockerComment = comments.find((c) => c.kind === "blocker");
    expect(blockerComment).toBeDefined();
    expect(blockerComment!.body.toLowerCase()).toContain("stale");
    expect(blockerComment!.body).toContain("Escalating");

    // Should have reassigned to CTO
    const updatedIssue = fix.state.issues.get("issue-stale");
    expect(updatedIssue!.assigneeAgentId).toBe("agent-cto");
  });

  it("does not escalate a recently updated task", async () => {
    const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    fix = await startMockServer({
      agents: [
        defaultAgent({
          id: "agent-se-1",
          name: "SoftwareEngineer-1",
          role: "SoftwareEngineer",
        }),
      ],
      issues: [
        defaultIssue({
          id: "issue-fresh",
          title: "Fresh task",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
          updatedAt: freshTime,
        }),
      ],
    });

    const freshIssue = fix.state.issues.get("issue-fresh")!;
    const agent = fix.state.agents.get("agent-se-1")!;

    const result = await escalateStaleTask(
      fix.baseUrl,
      freshIssue,
      agent,
      makeRunId(),
    );

    expect(result.escalated).toBe(false);
    expect(fix.state.comments.length).toBe(0);
  });

  it("escalates to board when agent has no reportsTo", async () => {
    const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    fix = await startMockServer({
      agents: [
        defaultAgent({
          id: "agent-ceo",
          name: "CEO",
          role: "CEO",
          chainOfCommand: { reportsTo: null, reports: [] },
        }),
      ],
      issues: [
        defaultIssue({
          id: "issue-ceo-stale",
          title: "CEO stale task",
          status: "in_progress",
          priority: "critical",
          assigneeAgentId: "agent-ceo",
          companyId: "company-1",
          updatedAt: staleTime,
        }),
      ],
    });

    const staleIssue = fix.state.issues.get("issue-ceo-stale")!;
    const agent = fix.state.agents.get("agent-ceo")!;

    const result = await escalateStaleTask(
      fix.baseUrl,
      staleIssue,
      agent,
      makeRunId(),
    );

    expect(result.escalated).toBe(true);
    const blocker = fix.state.comments.find((c) => c.kind === "blocker");
    expect(blocker!.body).toContain("board");
  });
});

// ── Dependency cycle detection ────────────────────────────────────────

describe("Heartbeat E2E — dependency cycle detection", () => {
  it("detects a simple two-way cycle (A blocked by B, B blocked by A)", () => {
    const issues = new Map<string, Issue>();
    issues.set(
      "A",
      defaultIssue({
        id: "A",
        title: "Task A",
        blockedByIssueIds: ["B"],
        status: "blocked",
        assigneeAgentId: "agent-001",
        companyId: "company-1",
      }),
    );
    issues.set(
      "B",
      defaultIssue({
        id: "B",
        title: "Task B",
        blockedByIssueIds: ["A"],
        status: "blocked",
        assigneeAgentId: "agent-001",
        companyId: "company-1",
      }),
    );

    const cycles = detectDependencyCycles(issues);
    expect(cycles.length).toBeGreaterThan(0);
    // Should find the cycle A → B → A
    const cycle = cycles.find((c) => c.length === 3);
    expect(cycle).toBeDefined();
    expect(cycle![0]).toBe("A");
    expect(cycle![2]).toBe("A"); // back to start
  });

  it("detects a three-way cycle", () => {
    const issues = new Map<string, Issue>();
    issues.set(
      "X",
      defaultIssue({
        id: "X",
        blockedByIssueIds: ["Y"],
        status: "blocked",
        assigneeAgentId: "agent-001",
        companyId: "company-1",
      }),
    );
    issues.set(
      "Y",
      defaultIssue({
        id: "Y",
        blockedByIssueIds: ["Z"],
        status: "blocked",
        assigneeAgentId: "agent-002",
        companyId: "company-1",
      }),
    );
    issues.set(
      "Z",
      defaultIssue({
        id: "Z",
        blockedByIssueIds: ["X"],
        status: "blocked",
        assigneeAgentId: "agent-003",
        companyId: "company-1",
      }),
    );

    const cycles = detectDependencyCycles(issues);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].length).toBe(4); // X → Y → Z → X
  });

  it("returns empty for acyclic dependency graph", () => {
    const issues = new Map<string, Issue>();
    issues.set(
      "A",
      defaultIssue({
        id: "A",
        blockedByIssueIds: ["B"],
        status: "blocked",
        assigneeAgentId: "agent-001",
        companyId: "company-1",
      }),
    );
    issues.set(
      "B",
      defaultIssue({
        id: "B",
        blockedByIssueIds: [],
        status: "todo",
        assigneeAgentId: "agent-002",
        companyId: "company-1",
      }),
    );

    const cycles = detectDependencyCycles(issues);
    expect(cycles.length).toBe(0);
  });

  it("cycle detection is included in heartbeat cycle result", async () => {
    const { app, state } = createMockPaperclipAPI({
      agents: [
        defaultAgent({
          id: "agent-se-1",
          name: "SoftwareEngineer-1",
          role: "SoftwareEngineer",
          capacity: { maxConcurrent: 3, current: 0 },
        }),
      ],
      issues: [
        defaultIssue({
          id: "cycle-A",
          title: "Cycle task A",
          status: "blocked",
          priority: "high",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
          blockedByIssueIds: ["cycle-B"],
        }),
        defaultIssue({
          id: "cycle-B",
          title: "Cycle task B",
          status: "blocked",
          priority: "high",
          assigneeAgentId: "agent-se-1",
          companyId: "company-1",
          blockedByIssueIds: ["cycle-A"],
        }),
      ],
    });

    const server = createHttpServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const result = await runHeartbeatCycle({
      agentId: "agent-se-1",
      companyId: "company-1",
      apiBaseUrl: baseUrl,
      runId: makeRunId(),
    });

    expect(result.dependencyCycleDetected).toBeDefined();
    expect(result.dependencyCycleDetected!.length).toBeGreaterThan(0);

    server.close();
  });
});

// ── Capacity gating ───────────────────────────────────────────────────

describe("Heartbeat E2E — capacity gating", () => {
  let fix: TestFixture;

  afterEach(() => {
    if (fix) teardown(fix);
  });

  it("rejects work when agent is at max capacity", async () => {
    fix = await startMockServer({
      agents: [
        defaultAgent({
          id: "agent-full",
          name: "Overloaded Engineer",
          role: "SoftwareEngineer",
          capacity: { maxConcurrent: 3, current: 3 },
        }),
      ],
      issues: [
        defaultIssue({
          id: "issue-overflow",
          title: "Extra task",
          status: "todo",
          priority: "high",
          assigneeAgentId: "agent-full",
          companyId: "company-1",
        }),
      ],
    });

    const result = await runHeartbeatCycle({
      agentId: "agent-full",
      companyId: "company-1",
      apiBaseUrl: fix.baseUrl,
      runId: makeRunId(),
    });

    expect(result.capacityExceeded).toBe(true);
    expect(result.step).toBe("capacity_gate");
    expect(result.cycleCompleted).toBe(true);
    // Issue should NOT have been checked out
    expect(fix.state.issues.get("issue-overflow")!.checkedOutById).toBeNull();
  });

  it("processes work normally when below capacity", async () => {
    fix = await startMockServer({
      agents: [
        defaultAgent({
          id: "agent-free",
          name: "Free Engineer",
          role: "SoftwareEngineer",
          capacity: { maxConcurrent: 3, current: 0 },
        }),
      ],
      issues: [
        defaultIssue({
          id: "issue-accept",
          title: "Acceptable task",
          status: "todo",
          priority: "high",
          assigneeAgentId: "agent-free",
          companyId: "company-1",
        }),
      ],
    });

    const result = await runHeartbeatCycle({
      agentId: "agent-free",
      companyId: "company-1",
      apiBaseUrl: fix.baseUrl,
      runId: makeRunId(),
    });

    expect(result.capacityExceeded).toBe(false);
    expect(result.cycleCompleted).toBe(true);
    expect(fix.state.issues.get("issue-accept")!.checkedOutById).toBe("agent-free");
  });
});

// ── Idle backoff behavior ─────────────────────────────────────────────

describe("Heartbeat E2E — idle backoff behavior", () => {
  let fix: TestFixture;

  afterEach(() => {
    if (fix) teardown(fix);
  });

  it("enters idle state when no assignments exist", async () => {
    fix = await startMockServer({
      agents: [
        defaultAgent({
          id: "agent-idle",
          name: "Idle Engineer",
          role: "SoftwareEngineer",
        }),
      ],
      issues: [], // no issues
    });

    const result = await runHeartbeatCycle({
      agentId: "agent-idle",
      companyId: "company-1",
      apiBaseUrl: fix.baseUrl,
      runId: makeRunId(),
    });

    expect(result.step).toBe("idle");
    expect(result.action).toContain("no assignments");
    expect(result.idleBackoffMs).toBeGreaterThan(0);
    expect(result.cycleCompleted).toBe(true);
  });

  it("idle backoff increases with consecutive idle cycles", () => {
    // First idle
    expect(getIdleBackoff(0)).toBe(60_000);
    // Second idle
    expect(getIdleBackoff(1)).toBe(120_000);
    // Fifth idle
    expect(getIdleBackoff(4)).toBe(900_000);
    // Maximum backoff (capped at last schedule entry)
    expect(getIdleBackoff(10)).toBe(1_800_000);
    expect(getIdleBackoff(100)).toBe(1_800_000);
  });

  it("backoff schedule is monotonically increasing", () => {
    const schedule = [0, 1, 2, 3, 4, 5, 10];
    for (let i = 1; i < schedule.length; i++) {
      expect(getIdleBackoff(schedule[i])).toBeGreaterThanOrEqual(
        getIdleBackoff(schedule[i - 1]),
      );
    }
  });
});

// ── HTTP heartbeat endpoint ───────────────────────────────────────────

describe("Heartbeat E2E — HTTP heartbeat endpoint", () => {
  let fix: TestFixture;

  afterEach(() => {
    if (fix) teardown(fix);
  });

  it("GET /api/heartbeat returns alive status for active agent", async () => {
    fix = await startMockServer();

    const response = await fetch(`${fix.baseUrl}/api/heartbeat`, {
      headers: { "X-Paperclip-Agent-Id": "agent-001" },
    });
    expect(response.status).toBe(200);

    const ping = (await response.json()) as any;
    expect(ping.agentId).toBe("agent-001");
    expect(ping.status).toBe("alive");
    expect(ping.cycleCount).toBe(0);
  });

  it("GET /api/heartbeat returns dead status for stale agent", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    fix = await startMockServer();
    // Simulate a stale ping
    fix.state.heartbeatPings["agent-001"] = {
      agentId: "agent-001",
      status: "alive",
      lastCycleAt: threeHoursAgo,
      currentTaskId: null,
      cycleCount: 1,
    };

    const response = await fetch(`${fix.baseUrl}/api/heartbeat`, {
      headers: { "X-Paperclip-Agent-Id": "agent-001" },
    });
    const ping = (await response.json()) as any;

    expect(ping.status).toBe("dead");
  });

  it("GET /api/heartbeat returns degraded for moderately late agent", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    fix = await startMockServer({
      staleThresholdMs: 30 * 60 * 1000, // 30 min threshold
    });
    fix.state.heartbeatPings["agent-001"] = {
      agentId: "agent-001",
      status: "alive",
      lastCycleAt: oneHourAgo,
      currentTaskId: null,
      cycleCount: 2,
    };

    const response = await fetch(`${fix.baseUrl}/api/heartbeat`, {
      headers: { "X-Paperclip-Agent-Id": "agent-001" },
    });
    const ping = (await response.json()) as any;

    // 1 hour > 1.5 * 30min = 45min, so degraded
    expect(ping.status).toBe("degraded");
  });

  it("POST /api/heartbeat records report and updates ping status", async () => {
    fix = await startMockServer();

    const response = await fetch(`${fix.baseUrl}/api/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": "test-run-1",
        "X-Paperclip-Agent-Id": "agent-001",
      },
      body: JSON.stringify({
        agentId: "agent-001",
        cycleCompleted: true,
        stepReached: 8,
        issuesProcessed: 1,
        errors: [],
        durationMs: 450,
      }),
    });

    expect(response.status).toBe(200);

    expect(fix.state.heartbeatReports.length).toBe(1);
    expect(fix.state.heartbeatReports[0].cycleCompleted).toBe(true);
    expect(fix.state.heartbeatReports[0].issuesProcessed).toBe(1);

    const ping = fix.state.heartbeatPings["agent-001"];
    expect(ping).toBeDefined();
    expect(ping.status).toBe("alive");
    expect(ping.cycleCount).toBe(1);
  });

  it("POST /api/heartbeat marks agent as degraded when errors reported", async () => {
    fix = await startMockServer();

    await fetch(`${fix.baseUrl}/api/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": "test-run-2",
        "X-Paperclip-Agent-Id": "agent-001",
      },
      body: JSON.stringify({
        agentId: "agent-001",
        cycleCompleted: false,
        stepReached: 4,
        issuesProcessed: 0,
        errors: ["API timeout"],
        durationMs: 5000,
      }),
    });

    expect(fix.state.heartbeatPings["agent-001"].status).toBe("degraded");
  });

  it("POST /api/heartbeat requires X-Paperclip-Run-Id header", async () => {
    fix = await startMockServer();

    const response = await fetch(`${fix.baseUrl}/api/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: "agent-001", cycleCompleted: true }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects checkout with 409 when issue already claimed by another agent", async () => {
    fix = await startMockServer({
      issues: [
        defaultIssue({
          id: "issue-conflict",
          title: "Conflicting task",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
          checkedOutById: "agent-002", // claimed by someone else
        }),
      ],
      checkouts: [["issue-conflict", "agent-002"]],
    });

    const response = await fetch(`${fix.baseUrl}/api/issues/issue-conflict/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": "test-run",
        "X-Paperclip-Agent-Id": "agent-001",
      },
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.checkedOutBy).toBe("agent-002");
  });
});

// ── Checkout flow integration ─────────────────────────────────────────

describe("Heartbeat E2E — checkout flow", () => {
  let fix: TestFixture;

  afterEach(() => {
    if (fix) teardown(fix);
  });

  it("checkout moves issue from todo to in_progress", async () => {
    fix = await startMockServer({
      issues: [
        defaultIssue({
          id: "issue-checkout",
          title: "Checkout test",
          status: "todo",
          priority: "medium",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
        }),
      ],
    });

    const response = await fetch(`${fix.baseUrl}/api/issues/issue-checkout/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": "test-run",
        "X-Paperclip-Agent-Id": "agent-001",
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.success).toBe(true);
    expect(body.issue.status).toBe("in_progress");
    expect(body.issue.checkedOutById).toBe("agent-001");
  });

  it("GET /api/companies/:id/issues filters by status", async () => {
    fix = await startMockServer({
      issues: [
        defaultIssue({
          id: "i1",
          title: "Todo task",
          status: "todo",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
        }),
        defaultIssue({
          id: "i2",
          title: "In progress task",
          status: "in_progress",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
        }),
        defaultIssue({
          id: "i3",
          title: "Done task",
          status: "done",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
        }),
      ],
    });

    const response = await fetch(
      `${fix.baseUrl}/api/companies/company-1/issues?assigneeAgentId=agent-001&status=todo,in_progress`,
      { headers: { "X-Paperclip-Agent-Id": "agent-001" } },
    );

    expect(response.status).toBe(200);
    const issues = (await response.json()) as Issue[];
    expect(issues.length).toBe(2);
    expect(issues.every((i) => ["todo", "in_progress"].includes(i.status))).toBe(true);
  });

  it("GET /api/companies/:id/issues returns in_progress first", async () => {
    fix = await startMockServer({
      issues: [
        defaultIssue({
          id: "i1",
          title: "Todo task",
          status: "todo",
          priority: "high",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
        }),
        defaultIssue({
          id: "i2",
          title: "In progress task",
          status: "in_progress",
          priority: "low",
          assigneeAgentId: "agent-001",
          companyId: "company-1",
        }),
      ],
    });

    const response = await fetch(
      `${fix.baseUrl}/api/companies/company-1/issues?assigneeAgentId=agent-001&status=todo,in_progress`,
      { headers: { "X-Paperclip-Agent-Id": "agent-001" } },
    );

    const issues = (await response.json()) as Issue[];
    expect(issues[0].status).toBe("in_progress");
  });
});
