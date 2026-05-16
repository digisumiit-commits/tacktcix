import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import config from "./config/index.js";
import prisma from "./utils/prisma.js";
import { verifyAccessToken } from "./utils/jwt.js";
import authRouter from "./routes/auth.js";
import organizationsRouter from "./routes/organizations.js";
import teamsRouter from "./routes/teams.js";
import workspacesRouter from "./routes/workspaces.js";
import { orgInvitesRouter, invitesRouter } from "./routes/invites.js";
import { billingRouter } from "./routes/billing.routes.js";

export async function createServer() {
  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  }));
  app.use(express.json());
  app.use(cookieParser());

  // Bridge JWT auth to req.user for backward compat with billing routes.
  // Billing inline auth checks (req as any).user?.id — we populate it
  // from a Bearer token if present, without rejecting unauthenticated requests
  // (the individual route middleware handles rejection).
  app.use((req, _res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = verifyAccessToken(authHeader.slice(7));
        (req as any).userId = payload.userId;
        (req as any).userEmail = payload.email;
        (req as any).user = { id: payload.userId, email: payload.email };
      } catch {
        // Token invalid — let route-level auth middleware reject
      }
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Auth routes
  app.use("/auth", authRouter);

  // Invite accept/validate (no org context needed)
  app.use("/invites", invitesRouter);

  // Organization-scoped routes
  app.use("/orgs", organizationsRouter);
  app.use("/orgs/:orgId/teams", teamsRouter);
  app.use("/orgs/:orgId/workspaces", workspacesRouter);
  app.use("/orgs/:orgId/invites", orgInvitesRouter);

  // Billing
  app.use("/api/billing", billingRouter);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Error]", err.message);
    res.status(500).json({ error: err.message || "Internal server error" });
  });

  return app;
}

async function main() {
  await prisma.$connect();

  const app = await createServer();
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  process.on("SIGTERM", async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
}

export default createServer;
