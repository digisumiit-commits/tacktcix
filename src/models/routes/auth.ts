import { Router, Request, Response } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import type { VerifyCallback } from "passport-google-oauth20";
import type { Profile as GitHubProfile } from "passport-github2";
import { z } from "zod";
import prisma from "../utils/prisma.js";
import { hashPassword, comparePassword } from "../utils/password.js";
import {
  signAccessToken,
  createRefreshToken,
  consumeRefreshToken,
  revokeUserRefreshTokens,
} from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { AuthenticatedRequest, AuthResponse } from "../types/index.js";
import config from "../config/index.js";

const router = Router();

// ── Passport OAuth setup ──────────────────────────────────────────

if (config.google.clientId) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
      },
      async (
        _accessToken: string,
        _refreshToken: string,
        profile: passport.Profile,
        done: VerifyCallback
      ) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error("No email from Google"));

          let user = await prisma.user.findUnique({
            where: { googleId: profile.id },
          });
          if (!user) {
            user = await prisma.user.create({
              data: {
                email,
                googleId: profile.id,
                name: profile.displayName || email.split("@")[0],
                avatarUrl: profile.photos?.[0]?.value,
              },
            });
          }
          done(null, user);
        } catch (err) {
          done(err as Error);
        }
      }
    )
  );
}

if (config.github.clientId) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: config.github.clientId,
        clientSecret: config.github.clientSecret,
        callbackURL: config.github.callbackUrl,
        scope: ["user:email"],
      },
      async (
        _accessToken: string,
        _refreshToken: string,
        profile: GitHubProfile,
        done: VerifyCallback
      ) => {
        try {
          const email =
            profile.emails?.[0]?.value ||
            (profile as any)._json?.email;
          if (!email) return done(new Error("No email from GitHub"));

          let user = await prisma.user.findUnique({
            where: { githubId: profile.id },
          });
          if (!user) {
            user = await prisma.user.create({
              data: {
                email,
                githubId: profile.id,
                name: profile.displayName || profile.username || email.split("@")[0],
                avatarUrl: profile.photos?.[0]?.value,
              },
            });
          }
          done(null, user);
        } catch (err) {
          done(err as Error);
        }
      }
    )
  );
}

// ── Helpers ───────────────────────────────────────────────────────

async function buildAuthResponse(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  googleId: string | null;
  githubId: string | null;
}): Promise<AuthResponse> {
  const accessToken = signAccessToken({
    userId: user.id,
    email: user.email,
  });
  const refreshToken = await createRefreshToken(user.id);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      googleId: user.googleId,
      githubId: user.githubId,
    },
    accessToken,
    refreshToken,
  };
}

// ── Validation schemas ────────────────────────────────────────────

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// ── POST /auth/signup ─────────────────────────────────────────────

router.post("/signup", async (req: Request, res: Response): Promise<void> => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name },
  });

  res.status(201).json(await buildAuthResponse(user));
});

// ── POST /auth/login ──────────────────────────────────────────────

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  res.json(await buildAuthResponse(user));
});

// ── POST /auth/refresh ────────────────────────────────────────────

router.post("/refresh", async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: "Refresh token is required" });
    return;
  }

  const stored = await consumeRefreshToken(refreshToken);
  if (!stored) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const accessToken = signAccessToken({
    userId: user.id,
    email: user.email,
  });
  const newRefreshToken = await createRefreshToken(user.id);

  res.json({ accessToken, refreshToken: newRefreshToken });
});

// ── POST /auth/logout ─────────────────────────────────────────────

router.post(
  "/logout",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await revokeUserRefreshTokens(req.userId!);
    res.json({ message: "Logged out successfully" });
  }
);

// ── GET /auth/me ──────────────────────────────────────────────────

router.get(
  "/me",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        googleId: true,
        githubId: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const orgs = await prisma.organizationMember.findMany({
      where: { userId: req.userId },
      include: { org: true },
    });

    res.json({
      ...user,
      organizations: orgs.map((m) => ({
        id: m.org.id,
        name: m.org.name,
        slug: m.org.slug,
        role: m.role,
      })),
    });
  }
);

// ── OAuth routes ──────────────────────────────────────────────────

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: "/auth/oauth-failure",
  }),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user as any;
    const auth = await buildAuthResponse(user);
    res.json(auth);
  }
);

router.get(
  "/github",
  passport.authenticate("github", {
    scope: ["user:email"],
    session: false,
  })
);

router.get(
  "/github/callback",
  passport.authenticate("github", {
    session: false,
    failureRedirect: "/auth/oauth-failure",
  }),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user as any;
    const auth = await buildAuthResponse(user);
    res.json(auth);
  }
);

router.get("/oauth-failure", (_req: Request, res: Response): void => {
  res.status(401).json({ error: "OAuth authentication failed" });
});

// ── PATCH /auth/profile ───────────────────────────────────────────

router.patch(
  "/profile",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { name, avatarUrl } = req.body;
    const data: Record<string, unknown> = {};
    if (name) data.name = name;
    if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        googleId: true,
        githubId: true,
      },
    });

    res.json(user);
  }
);

// ── POST /auth/change-password ────────────────────────────────────

router.post(
  "/change-password",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "currentPassword and newPassword are required" });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.passwordHash) {
      res.status(400).json({ error: "Password-based account required" });
      return;
    }

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: req.userId },
      data: { passwordHash },
    });
    await revokeUserRefreshTokens(req.userId!);

    res.json({ message: "Password changed successfully" });
  }
);

export default router;
