import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "node:http";
import http from "node:http";
import type { Express } from "express";

// ── Mock Prisma ─────────────────────────────────────────────────────

const mockUser = {
  id: "user-1",
  email: "test@example.com",
  passwordHash: "$2a$12$hashed_password",
  name: "Test User",
  avatarUrl: null,
  googleId: null,
  githubId: null,
  createdAt: new Date("2026-01-01"),
};

const mockRefreshToken = {
  id: "rt-1",
  token: "a".repeat(128),
  userId: "user-1",
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
};

const mockOrgMemberships = [
  {
    orgId: "org-1",
    org: { id: "org-1", name: "Test Org", slug: "test-org" },
    role: "FOUNDER",
  },
];

// Set OAuth env vars before module imports so passport strategies register
process.env.GOOGLE_CLIENT_ID = "mock-google-id";
process.env.GOOGLE_CLIENT_SECRET = "mock-google-secret";
process.env.GITHUB_CLIENT_ID = "mock-github-id";
process.env.GITHUB_CLIENT_SECRET = "mock-github-secret";

vi.mock("../src/utils/prisma.js", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    refreshToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    organizationMember: {
      findMany: vi.fn(),
    },
  },
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

vi.mock("../src/utils/password.js", async () => {
  const actual = await vi.importActual("../src/utils/password.js");
  return {
    ...actual,
    hashPassword: vi.fn().mockResolvedValue("$2a$12$hashed_password"),
    comparePassword: vi.fn(),
  };
});

// ── Helper ───────────────────────────────────────────────────────────

async function createApp(): Promise<Express> {
  const express = await import("express");
  const app = express.default();
  app.use(express.default.json());
  const authRouter = (await import("../src/routes/auth.js")).default;
  app.use("/auth", authRouter);
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /auth/signup", () => {
  let app: Express;
  let prisma: any;
  let password: any;

  beforeEach(async () => {
    app = await createApp();
    prisma = (await import("../src/utils/prisma.js")).default;
    password = await import("../src/utils/password.js");
    // Reset mocks
    prisma.user.findUnique.mockReset();
    prisma.user.create.mockReset();
  });

  it("creates a new user and returns 201 with tokens", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(mockUser);

    const res = await request(app, "POST", "/auth/signup", {
      body: { email: "test@example.com", password: "password123", name: "Test User" },
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe("test@example.com");
    expect(res.body.accessToken).toBe("access-token-mock");
    expect(res.body.refreshToken).toBe("refresh-token-mock");
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "test@example.com", name: "Test User" }),
      }),
    );
    expect(password.hashPassword).toHaveBeenCalledWith("password123");
  });

  it("returns 409 when email already exists", async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);

    const res = await request(app, "POST", "/auth/signup", {
      body: { email: "test@example.com", password: "password123", name: "Test User" },
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already registered");
  });

  it("returns 400 on invalid email", async () => {
    const res = await request(app, "POST", "/auth/signup", {
      body: { email: "not-an-email", password: "password123", name: "Test" },
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 on short password", async () => {
    const res = await request(app, "POST", "/auth/signup", {
      body: { email: "test@example.com", password: "short", name: "Test" },
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  let app: Express;
  let prisma: any;
  let password: any;

  beforeEach(async () => {
    app = await createApp();
    prisma = (await import("../src/utils/prisma.js")).default;
    password = await import("../src/utils/password.js");
    prisma.user.findUnique.mockReset();
    password.comparePassword.mockReset();
  });

  it("logs in with valid credentials", async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    password.comparePassword.mockResolvedValue(true);

    const res = await request(app, "POST", "/auth/login", {
      body: { email: "test@example.com", password: "password123" },
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe("access-token-mock");
    expect(password.comparePassword).toHaveBeenCalledWith("password123", mockUser.passwordHash);
  });

  it("returns 401 with wrong password", async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    password.comparePassword.mockResolvedValue(false);

    const res = await request(app, "POST", "/auth/login", {
      body: { email: "test@example.com", password: "wrong" },
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid");
  });

  it("returns 401 for unknown email", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app, "POST", "/auth/login", {
      body: { email: "unknown@example.com", password: "password123" },
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 for OAuth-only user (no passwordHash)", async () => {
    const oauthUser = { ...mockUser, passwordHash: null };
    prisma.user.findUnique.mockResolvedValue(oauthUser);

    const res = await request(app, "POST", "/auth/login", {
      body: { email: "oauth@example.com", password: "any" },
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /auth/refresh", () => {
  let app: Express;
  let jwt: any;
  let prisma: any;

  beforeEach(async () => {
    app = await createApp();
    jwt = await import("../src/utils/jwt.js");
    prisma = (await import("../src/utils/prisma.js")).default;
    jwt.consumeRefreshToken.mockReset();
    prisma.user.findUnique.mockReset();
  });

  it("returns new tokens with valid refresh token", async () => {
    jwt.consumeRefreshToken.mockResolvedValue(mockRefreshToken);
    prisma.user.findUnique.mockResolvedValue(mockUser);

    const res = await request(app, "POST", "/auth/refresh", {
      body: { refreshToken: "valid-refresh-token" },
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe("access-token-mock");
    expect(res.body.refreshToken).toBe("refresh-token-mock");
    expect(jwt.consumeRefreshToken).toHaveBeenCalledWith("valid-refresh-token");
  });

  it("returns 401 with invalid refresh token", async () => {
    jwt.consumeRefreshToken.mockResolvedValue(null);

    const res = await request(app, "POST", "/auth/refresh", {
      body: { refreshToken: "invalid-token" },
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 when refresh token not provided", async () => {
    const res = await request(app, "POST", "/auth/refresh", { body: {} });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/logout", () => {
  let app: Express;
  let jwt: any;

  beforeEach(async () => {
    app = await createApp();
    jwt = await import("../src/utils/jwt.js");
  });

  it("revokes all refresh tokens", async () => {
    const res = await request(app, "POST", "/auth/logout", {
      headers: { Authorization: "Bearer valid-token" },
    });

    expect(res.status).toBe(200);
    expect(jwt.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1");
  });

  it("returns 401 without auth header", async () => {
    const res = await request(app, "POST", "/auth/logout");
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/me", () => {
  let app: Express;
  let prisma: any;

  beforeEach(async () => {
    app = await createApp();
    prisma = (await import("../src/utils/prisma.js")).default;
    prisma.user.findUnique.mockReset();
    prisma.organizationMember.findMany.mockReset();
  });

  it("returns user profile with org memberships", async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.organizationMember.findMany.mockResolvedValue(mockOrgMemberships);

    const res = await request(app, "GET", "/auth/me", {
      headers: { Authorization: "Bearer valid-token" },
    });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("test@example.com");
    expect(res.body.organizations).toHaveLength(1);
    expect(res.body.organizations[0].name).toBe("Test Org");
  });

  it("returns 404 when user not found", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app, "GET", "/auth/me", {
      headers: { Authorization: "Bearer valid-token" },
    });

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app, "GET", "/auth/me");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /auth/profile", () => {
  let app: Express;
  let prisma: any;

  beforeEach(async () => {
    app = await createApp();
    prisma = (await import("../src/utils/prisma.js")).default;
    prisma.user.update.mockReset();
  });

  it("updates user name", async () => {
    prisma.user.update.mockResolvedValue({ ...mockUser, name: "Updated Name" });

    const res = await request(app, "PATCH", "/auth/profile", {
      headers: { Authorization: "Bearer valid-token" },
      body: { name: "Updated Name" },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: { name: "Updated Name" },
      }),
    );
  });

  it("returns 400 with no fields to update", async () => {
    const res = await request(app, "PATCH", "/auth/profile", {
      headers: { Authorization: "Bearer valid-token" },
      body: {},
    });

    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app, "PATCH", "/auth/profile", { body: { name: "Test" } });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/change-password", () => {
  let app: Express;
  let prisma: any;
  let password: any;
  let jwt: any;

  beforeEach(async () => {
    app = await createApp();
    prisma = (await import("../src/utils/prisma.js")).default;
    password = await import("../src/utils/password.js");
    jwt = await import("../src/utils/jwt.js");
    prisma.user.findUnique.mockReset();
    password.comparePassword.mockReset();
  });

  it("changes password with valid current password", async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    password.comparePassword.mockResolvedValue(true);

    const res = await request(app, "POST", "/auth/change-password", {
      headers: { Authorization: "Bearer valid-token" },
      body: { currentPassword: "oldpass", newPassword: "newlongpass" },
    });

    expect(res.status).toBe(200);
    expect(password.hashPassword).toHaveBeenCalledWith("newlongpass");
    expect(jwt.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1");
  });

  it("returns 401 with wrong current password", async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    password.comparePassword.mockResolvedValue(false);

    const res = await request(app, "POST", "/auth/change-password", {
      headers: { Authorization: "Bearer valid-token" },
      body: { currentPassword: "wrong", newPassword: "newlongpass" },
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 for OAuth-only user", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...mockUser, passwordHash: null });

    const res = await request(app, "POST", "/auth/change-password", {
      headers: { Authorization: "Bearer valid-token" },
      body: { currentPassword: "any", newPassword: "newlongpass" },
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 with short new password", async () => {
    const res = await request(app, "POST", "/auth/change-password", {
      headers: { Authorization: "Bearer valid-token" },
      body: { currentPassword: "oldpass", newPassword: "short" },
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /auth/google /auth/github", () => {
  let app: Express;

  beforeEach(async () => {
    app = await createApp();
  });

  it("redirects to Google OAuth", async () => {
    const res = await request(app, "GET", "/auth/google");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
  });

  it("redirects to GitHub OAuth", async () => {
    const res = await request(app, "GET", "/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github.com");
  });

  it("returns 401 on /auth/oauth-failure", async () => {
    const res = await request(app, "GET", "/auth/oauth-failure");
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/google/callback and /auth/github/callback", () => {
  let app: Express;

  beforeEach(async () => {
    app = await createApp();
  });

  it("redirects on Google callback without OAuth code (passport initiates auth)", async () => {
    const res = await request(app, "GET", "/auth/google/callback");
    // Passport redirects to Google auth when no code param is present
    expect(res.status).toBe(302);
  });

  it("redirects on GitHub callback without OAuth code", async () => {
    const res = await request(app, "GET", "/auth/github/callback");
    expect(res.status).toBe(302);
  });
});

describe("JWT utility tests", () => {
  it("signAccessToken is called with correct payload", async () => {
    const app = await createApp();
    const jwt = await import("../src/utils/jwt.js");
    const prisma = (await import("../src/utils/prisma.js")).default;
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(mockUser);

    await request(app, "POST", "/auth/signup", {
      body: { email: "test@example.com", password: "password123", name: "Test" },
    });

    expect(jwt.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", email: "test@example.com" }),
    );
    expect(jwt.createRefreshToken).toHaveBeenCalledWith("user-1");
  });
});
