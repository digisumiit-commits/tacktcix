import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "node:http";
import http from "node:http";
import type { Express } from "express";

// ── Mock Prisma ─────────────────────────────────────────────────────

const mockPrisma = {
  organization: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  organizationMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  team: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  teamMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  workspace: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  workspaceMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  invite: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn((ops: any[]) =>
    Promise.all(ops.map((op: any) => (typeof op === "function" ? op() : op))),
  ),
};

vi.mock("../src/utils/prisma.js", () => ({
  default: mockPrisma,
}));

vi.mock("../src/utils/jwt.js", async () => {
  const actual = await vi.importActual("../src/utils/jwt.js");
  return {
    ...actual,
    signAccessToken: vi.fn().mockReturnValue("access-token-mock"),
    createRefreshToken: vi.fn().mockResolvedValue("refresh-token-mock"),
    consumeRefreshToken: vi.fn(),
    revokeUserRefreshTokens: vi.fn().mockResolvedValue(undefined),
    verifyAccessToken: vi.fn().mockReturnValue({ userId: "user-1", email: "test@example.com" }),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────

async function makeApp(mount: (app: Express) => Promise<void>): Promise<Express> {
  const express = await import("express");
  const app = express.default();
  app.use(express.default.json());
  await mount(app);
  // Error handler must be AFTER routes
  app.use((err: Error, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message || "Internal server error" });
  });
  return app;
}

function request(
  app: Express,
  method: string,
  url: string,
  options?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const body = options?.body ? JSON.stringify(options.body) : undefined;
      const req = http.request(
        {
          hostname: "localhost",
          port,
          path: url,
          method,
          headers: {
            "Content-Type": "application/json",
            ...options?.headers,
            ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
            } catch {
              resolve({ status: res.statusCode!, body: data, headers: res.headers });
            }
          });
        },
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  });
}

const authHeaders = { Authorization: "Bearer valid-token" };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Organization Tests ──────────────────────────────────────────────

describe("Organizations", () => {
  let prisma: any;

  beforeEach(() => {
    prisma = mockPrisma;
  });

  describe("POST /orgs", () => {
    it("creates an organization with FOUNDER role", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organization.findUnique.mockResolvedValue(null);
      prisma.organization.create.mockResolvedValue({ id: "org-1", name: "Test Org", slug: "test-org", description: null, createdById: "user-1" });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "FOUNDER", org: { id: "org-1", name: "Test Org", slug: "test-org", description: null } });
      prisma.organizationMember.count.mockResolvedValue(1);

      const res = await request(app, "POST", "/orgs", { headers: authHeaders, body: { name: "Test Org", slug: "test-org" } });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Test Org");
      expect(res.body.role).toBe("FOUNDER");
    });

    it("returns 409 for duplicate slug", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organization.findUnique.mockResolvedValue({ id: "existing" });

      const res = await request(app, "POST", "/orgs", { headers: authHeaders, body: { name: "Test", slug: "test-org" } });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /orgs", () => {
    it("lists user's organizations", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findMany.mockResolvedValue([{ role: "FOUNDER", org: { id: "org-1", name: "Test Org", slug: "test-org", description: null, _count: { members: 3 } } }]);

      const res = await request(app, "GET", "/orgs", { headers: authHeaders });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].memberCount).toBe(3);
    });
  });

  describe("GET /orgs/:orgId", () => {
    it("returns org details for member", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "DEVELOPER", org: { id: "org-1", name: "Test Org", slug: "test-org", description: null } });
      prisma.organizationMember.count.mockResolvedValue(5);

      const res = await request(app, "GET", "/orgs/org-1", { headers: authHeaders });
      expect(res.status).toBe(200);
      expect(res.body.memberCount).toBe(5);
    });
  });

  describe("PATCH /orgs/:orgId", () => {
    it("updates org name (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      // requireOrgRole middleware calls findUnique first (no .org needed)
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        // buildOrgWithRole calls findUnique with include: { org: true }
        .mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN", org: { id: "org-1", name: "Updated", slug: "test-org", description: null } });
      prisma.organization.update.mockResolvedValue({ id: "org-1", name: "Updated", slug: "test-org", description: null });
      prisma.organizationMember.count.mockResolvedValue(3);

      const res = await request(app, "PATCH", "/orgs/org-1", { headers: authHeaders, body: { name: "Updated" } });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });

    it("returns 403 for OBSERVER", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "OBSERVER" });

      const res = await request(app, "PATCH", "/orgs/org-1", { headers: authHeaders, body: { name: "Updated" } });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /orgs/:orgId", () => {
    it("deletes org for FOUNDER", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "FOUNDER" });
      prisma.organization.delete.mockResolvedValue({ id: "org-1" });

      const res = await request(app, "DELETE", "/orgs/org-1", { headers: authHeaders });
      expect(res.status).toBe(200);
    });

    it("returns 403 for ADMIN", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });

      const res = await request(app, "DELETE", "/orgs/org-1", { headers: authHeaders });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /orgs/:orgId/members", () => {
    it("lists org members", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.organizationMember.findMany.mockResolvedValue([{ id: "m1", role: "FOUNDER", joinedAt: new Date(), user: { id: "user-1", email: "admin@test.com", name: "Admin", avatarUrl: null } }]);

      const res = await request(app, "GET", "/orgs/org-1/members", { headers: authHeaders });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("PATCH /orgs/:orgId/members/:userId/role", () => {
    it("changes member role (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" }) // caller
        .mockResolvedValueOnce({ id: "m2", orgId: "org-1", userId: "user-2", role: "DEVELOPER" }); // target
      prisma.organizationMember.update.mockResolvedValue({ id: "m2", role: "OPERATOR", joinedAt: new Date(), user: { id: "user-2", email: "dev@test.com", name: "Dev", avatarUrl: null } });

      const res = await request(app, "PATCH", "/orgs/org-1/members/user-2/role", { headers: authHeaders, body: { role: "OPERATOR" } });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("OPERATOR");
    });

    it("cannot change FOUNDER role", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        .mockResolvedValueOnce({ id: "m2", orgId: "org-1", userId: "user-2", role: "FOUNDER" });

      const res = await request(app, "PATCH", "/orgs/org-1/members/user-2/role", { headers: authHeaders, body: { role: "DEVELOPER" } });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /orgs/:orgId/members/:userId", () => {
    it("removes member (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      // requireOrgRole("ADMIN") checks caller
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        // Handler checks target member
        .mockResolvedValue({ id: "m2", orgId: "org-1", userId: "user-2", role: "DEVELOPER" });

      const res = await request(app, "DELETE", "/orgs/org-1/members/user-2", { headers: authHeaders });
      expect(res.status).toBe(200);
    });

    it("cannot remove FOUNDER", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        .mockResolvedValue({ id: "m2", orgId: "org-1", userId: "user-2", role: "FOUNDER" });

      const res = await request(app, "DELETE", "/orgs/org-1/members/user-2", { headers: authHeaders });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /orgs/:orgId/transfer-ownership", () => {
    it("transfers ownership (FOUNDER)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/organizations.js")).default;
        a.use("/orgs", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "FOUNDER" }) // caller
        .mockResolvedValueOnce({ id: "m2", orgId: "org-1", userId: "user-2", role: "ADMIN" }); // target

      const res = await request(app, "POST", "/orgs/org-1/transfer-ownership", { headers: authHeaders, body: { newOwnerUserId: "user-2" } });
      expect(res.status).toBe(200);
    });
  });
});

// ── Team Tests ──────────────────────────────────────────────────────

describe("Teams", () => {
  let prisma: any;

  beforeEach(() => {
    prisma = mockPrisma;
  });

  describe("POST /orgs/:orgId/teams", () => {
    it("creates a team (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/teams.js")).default;
        a.use("/orgs/:orgId/teams", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.team.create.mockResolvedValue({ id: "team-1", name: "Dev Team", description: null, orgId: "org-1", createdById: "user-1", _count: { members: 1, workspaces: 0 } });

      const res = await request(app, "POST", "/orgs/org-1/teams", { headers: authHeaders, body: { name: "Dev Team" } });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Dev Team");
    });

    it("returns 403 for DEVELOPER", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/teams.js")).default;
        a.use("/orgs/:orgId/teams", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "DEVELOPER" });

      const res = await request(app, "POST", "/orgs/org-1/teams", { headers: authHeaders, body: { name: "Dev Team" } });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /orgs/:orgId/teams", () => {
    it("lists teams", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/teams.js")).default;
        a.use("/orgs/:orgId/teams", r);
      });
      prisma.team.findMany.mockResolvedValue([{ id: "team-1", name: "Dev Team", _count: { members: 2, workspaces: 1 } }]);

      const res = await request(app, "GET", "/orgs/org-1/teams", { headers: authHeaders });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("POST /orgs/:orgId/teams/:teamId/members", () => {
    it("adds org member to team (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/teams.js")).default;
        a.use("/orgs/:orgId/teams", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-2", role: "DEVELOPER" });
      prisma.teamMember.findUnique.mockResolvedValue(null);
      prisma.teamMember.create.mockResolvedValue({ id: "tm1", role: "MEMBER", joinedAt: new Date(), user: { id: "user-2", email: "dev@test.com", name: "Dev", avatarUrl: null } });
      prisma.workspace.findMany.mockResolvedValue([]);

      const res = await request(app, "POST", "/orgs/org-1/teams/team-1/members", { headers: authHeaders, body: { userId: "user-2" } });
      expect(res.status).toBe(201);
    });

    it("rejects non-org member", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/teams.js")).default;
        a.use("/orgs/:orgId/teams", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        .mockResolvedValueOnce(null);

      const res = await request(app, "POST", "/orgs/org-1/teams/team-1/members", { headers: authHeaders, body: { userId: "user-2" } });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /orgs/:orgId/teams/:teamId/members/:userId", () => {
    it("removes team member (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/teams.js")).default;
        a.use("/orgs/:orgId/teams", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.teamMember.findUnique.mockResolvedValue({ id: "tm1", teamId: "team-1", userId: "user-2" });

      const res = await request(app, "DELETE", "/orgs/org-1/teams/team-1/members/user-2", { headers: authHeaders });
      expect(res.status).toBe(200);
    });
  });
});

// ── Workspace Tests ─────────────────────────────────────────────────

describe("Workspaces", () => {
  let prisma: any;

  beforeEach(() => {
    prisma = mockPrisma;
  });

  describe("POST /orgs/:orgId/workspaces", () => {
    it("creates a workspace (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/workspaces.js")).default;
        a.use("/orgs/:orgId/workspaces", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.workspace.create.mockResolvedValue({ id: "ws-1", name: "My Workspace", description: null, orgId: "org-1", teamId: null, _count: { members: 1 } });

      const res = await request(app, "POST", "/orgs/org-1/workspaces", { headers: authHeaders, body: { name: "My Workspace" } });
      expect(res.status).toBe(201);
    });

    it("associates with a team", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/workspaces.js")).default;
        a.use("/orgs/:orgId/workspaces", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.team.findUnique.mockResolvedValue({ id: "550e8400-e29b-41d4-a716-446655440000", orgId: "org-1", name: "Dev Team" });
      prisma.workspace.create.mockResolvedValue({ id: "ws-1", name: "Team Workspace", description: null, orgId: "org-1", teamId: "550e8400-e29b-41d4-a716-446655440000", team: { id: "550e8400-e29b-41d4-a716-446655440000", name: "Dev Team" }, _count: { members: 1 } });
      prisma.teamMember.findMany.mockResolvedValue([]);

      const res = await request(app, "POST", "/orgs/org-1/workspaces", { headers: authHeaders, body: { name: "Team Workspace", teamId: "550e8400-e29b-41d4-a716-446655440000" } });
      expect(res.status).toBe(201);
    });

    it("validates team belongs to org", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/workspaces.js")).default;
        a.use("/orgs/:orgId/workspaces", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.team.findUnique.mockResolvedValue({ id: "550e8400-e29b-41d4-a716-446655440001", orgId: "org-2" });

      const res = await request(app, "POST", "/orgs/org-1/workspaces", { headers: authHeaders, body: { name: "Workspace", teamId: "550e8400-e29b-41d4-a716-446655440001" } });
      expect(res.status).toBe(400);
    });
  });

  describe("Workspace members", () => {
    it("lists members", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/workspaces.js")).default;
        a.use("/orgs/:orgId/workspaces", r);
      });
      prisma.workspaceMember.findMany.mockResolvedValue([{ id: "wm1", joinedAt: new Date(), user: { id: "user-1", email: "admin@test.com", name: "Admin", avatarUrl: null } }]);

      const res = await request(app, "GET", "/orgs/org-1/workspaces/ws-1/members", { headers: authHeaders });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("adds member (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/workspaces.js")).default;
        a.use("/orgs/:orgId/workspaces", r);
      });
      prisma.organizationMember.findUnique
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", role: "ADMIN" })
        .mockResolvedValueOnce({ orgId: "org-1", userId: "user-2", role: "DEVELOPER" });
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      prisma.workspaceMember.create.mockResolvedValue({ id: "wm1", joinedAt: new Date(), user: { id: "user-2", email: "dev@test.com", name: "Dev", avatarUrl: null } });

      const res = await request(app, "POST", "/orgs/org-1/workspaces/ws-1/members", { headers: authHeaders, body: { userId: "user-2" } });
      expect(res.status).toBe(201);
    });

    it("removes member (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const r = (await import("../src/routes/workspaces.js")).default;
        a.use("/orgs/:orgId/workspaces", r);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.workspaceMember.findUnique.mockResolvedValue({ id: "wm1", workspaceId: "ws-1", userId: "user-2" });

      const res = await request(app, "DELETE", "/orgs/org-1/workspaces/ws-1/members/user-2", { headers: authHeaders });
      expect(res.status).toBe(200);
    });
  });
});

// ── Invite Tests ────────────────────────────────────────────────────

describe("Invites", () => {
  let prisma: any;

  beforeEach(() => {
    prisma = mockPrisma;
  });

  describe("POST /orgs/:orgId/invites", () => {
    it("creates an invite (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const { orgInvitesRouter } = await import("../src/routes/invites.js");
        a.use("/orgs/:orgId/invites", orgInvitesRouter);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invite.findFirst.mockResolvedValue(null);
      prisma.invite.create.mockResolvedValue({ id: "inv-1", email: "newuser@test.com", orgId: "org-1", role: "DEVELOPER", token: "some-token", status: "PENDING", expiresAt: new Date(), invitedBy: { id: "user-1", email: "admin@test.com", name: "Admin" }, team: null });

      const res = await request(app, "POST", "/orgs/org-1/invites", { headers: authHeaders, body: { email: "newuser@test.com", role: "DEVELOPER" } });
      expect(res.status).toBe(201);
      expect(res.body.inviteLink).toContain("token=");
    });

    it("rejects duplicate pending invite", async () => {
      const app = await makeApp(async (a) => {
        const { orgInvitesRouter } = await import("../src/routes/invites.js");
        a.use("/orgs/:orgId/invites", orgInvitesRouter);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invite.findFirst.mockResolvedValue({ id: "existing" });

      const res = await request(app, "POST", "/orgs/org-1/invites", { headers: authHeaders, body: { email: "newuser@test.com", role: "DEVELOPER" } });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /orgs/:orgId/invites", () => {
    it("lists invites (ADMIN+)", async () => {
      const app = await makeApp(async (a) => {
        const { orgInvitesRouter } = await import("../src/routes/invites.js");
        a.use("/orgs/:orgId/invites", orgInvitesRouter);
      });
      prisma.organizationMember.findUnique.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "ADMIN" });
      prisma.invite.findMany.mockResolvedValue([{ id: "inv-1", email: "newuser@test.com", role: "DEVELOPER", status: "PENDING", invitedBy: { id: "user-1", email: "admin@test.com", name: "Admin" }, team: null }]);

      const res = await request(app, "GET", "/orgs/org-1/invites", { headers: authHeaders });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("POST /invites/accept", () => {
    const activeInvite = {
      id: "inv-1",
      email: "newuser@test.com",
      orgId: "org-1",
      teamId: null,
      role: "DEVELOPER",
      token: "valid-token",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 86400000),
      invitedById: "user-1",
      org: { id: "org-1", name: "Test Org", slug: "test-org" },
      team: null,
    };

    it("accepts invite for new user", async () => {
      const app = await makeApp(async (a) => {
        const { invitesRouter } = await import("../src/routes/invites.js");
        a.use("/invites", invitesRouter);
      });
      prisma.invite.findUnique.mockResolvedValue(activeInvite);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "user-2", email: "newuser@test.com", name: "New User", avatarUrl: null, passwordHash: "$2a$12$hashed" });
      prisma.organizationMember.upsert.mockResolvedValue({});

      const res = await request(app, "POST", "/invites/accept", { body: { token: "valid-token", name: "New User", password: "password123" } });
      expect(res.status).toBe(200);
      expect(res.body.organization.name).toBe("Test Org");
    });

    it("accepts invite for existing OAuth user", async () => {
      const app = await makeApp(async (a) => {
        const { invitesRouter } = await import("../src/routes/invites.js");
        a.use("/invites", invitesRouter);
      });
      prisma.invite.findUnique.mockResolvedValue(activeInvite);
      prisma.user.findUnique.mockResolvedValue({ id: "user-2", email: "newuser@test.com", name: "Existing", avatarUrl: null, passwordHash: null });
      prisma.user.update.mockResolvedValue({ id: "user-2", email: "newuser@test.com", name: "Existing", avatarUrl: null, passwordHash: "$2a$12$hashed" });
      prisma.organizationMember.upsert.mockResolvedValue({});

      const res = await request(app, "POST", "/invites/accept", { body: { token: "valid-token", name: "Existing", password: "password123" } });
      expect(res.status).toBe(200);
    });

    it("rejects expired invite", async () => {
      const app = await makeApp(async (a) => {
        const { invitesRouter } = await import("../src/routes/invites.js");
        a.use("/invites", invitesRouter);
      });
      prisma.invite.findUnique.mockResolvedValue({ ...activeInvite, expiresAt: new Date(Date.now() - 86400000) });

      const res = await request(app, "POST", "/invites/accept", { body: { token: "expired", name: "U", password: "password123" } });
      expect(res.status).toBe(410);
    });

    it("rejects invalid token", async () => {
      const app = await makeApp(async (a) => {
        const { invitesRouter } = await import("../src/routes/invites.js");
        a.use("/invites", invitesRouter);
      });
      prisma.invite.findUnique.mockResolvedValue(null);

      const res = await request(app, "POST", "/invites/accept", { body: { token: "invalid", name: "U", password: "password123" } });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /invites/validate/:token", () => {
    it("returns invite info for valid token", async () => {
      const app = await makeApp(async (a) => {
        const { invitesRouter } = await import("../src/routes/invites.js");
        a.use("/invites", invitesRouter);
      });
      prisma.invite.findUnique.mockResolvedValue({ id: "inv-1", email: "user@test.com", status: "PENDING", role: "DEVELOPER", expiresAt: new Date(Date.now() + 86400000), org: { id: "org-1", name: "Test Org", slug: "test-org" }, team: null, invitedBy: { name: "Admin", email: "admin@test.com" } });

      const res = await request(app, "GET", "/invites/validate/valid-token");
      expect(res.status).toBe(200);
      expect(res.body.email).toBe("user@test.com");
    });
  });
});
