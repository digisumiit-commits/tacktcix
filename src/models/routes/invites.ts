import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import prisma from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireOrgRole } from "../middleware/rbac.js";
import { AuthenticatedRequest } from "../types/index.js";
import { OrgRole } from "@prisma/client";

const router = Router({ mergeParams: true });

// ── Validation ────────────────────────────────────────────────────

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrgRole).refine((r) => r !== "FOUNDER", {
    message: "Cannot invite someone as Founder",
  }),
  teamId: z.string().uuid().optional(),
});

const acceptInviteSchema = z.object({
  token: z.string(),
  name: z.string().min(1).max(100),
  password: z.string().min(8),
});

// ── POST /orgs/:orgId/invites ─────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = createInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { email, role, teamId } = parsed.data;

    // Check if user is already an org member
    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: {
        orgMemberships: {
          where: { orgId: req.params.orgId },
        },
      },
    });

    if (existingUser?.orgMemberships.length) {
      res.status(409).json({ error: "User is already a member of this organization" });
      return;
    }

    // If teamId specified, verify it belongs to this org
    if (teamId) {
      const team = await prisma.team.findUnique({
        where: { id: teamId },
      });
      if (!team || team.orgId !== req.params.orgId) {
        res.status(400).json({ error: "Team not found in this organization" });
        return;
      }
    }

    // Check for existing pending invite for the same email
    const existingInvite = await prisma.invite.findFirst({
      where: {
        email,
        orgId: req.params.orgId,
        status: "PENDING",
      },
    });
    if (existingInvite) {
      res.status(409).json({ error: "A pending invite already exists for this email" });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invite = await prisma.invite.create({
      data: {
        email,
        orgId: req.params.orgId,
        teamId: teamId || null,
        role,
        token,
        invitedById: req.userId!,
        expiresAt,
      },
      include: {
        invitedBy: {
          select: { id: true, email: true, name: true },
        },
        team: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      ...invite,
      inviteLink: `/invites/accept?token=${token}`,
    });
  }
);

// ── GET /orgs/:orgId/invites ──────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { status } = req.query;
    const where: Record<string, unknown> = { orgId: req.params.orgId };
    if (status && ["PENDING", "ACCEPTED", "DECLINED", "EXPIRED"].includes(status as string)) {
      where.status = status;
    }

    const invites = await prisma.invite.findMany({
      where,
      include: {
        invitedBy: {
          select: { id: true, email: true, name: true },
        },
        team: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(invites);
  }
);

// ── DELETE /orgs/:orgId/invites/:inviteId ─────────────────────────

router.delete(
  "/:inviteId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const invite = await prisma.invite.findUnique({
      where: { id: req.params.inviteId },
    });

    if (!invite || invite.orgId !== req.params.orgId) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }

    await prisma.invite.delete({ where: { id: req.params.inviteId } });
    res.json({ message: "Invite revoked" });
  }
);

// ── POST /invites/accept ──────────────────────────────────────────

const invitesRouter = Router();

invitesRouter.post(
  "/accept",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = acceptInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { token, name, password } = parsed.data;

    const invite = await prisma.invite.findUnique({
      where: { token },
      include: { org: true, team: true },
    });

    if (!invite) {
      res.status(404).json({ error: "Invalid invite token" });
      return;
    }

    if (invite.status !== "PENDING") {
      res.status(410).json({ error: `Invite is ${invite.status.toLowerCase()}` });
      return;
    }

    if (invite.expiresAt < new Date()) {
      await prisma.invite.update({
        where: { id: invite.id },
        data: { status: "EXPIRED" },
      });
      res.status(410).json({ error: "Invite has expired" });
      return;
    }

    // Find or create user
    const { hashPassword } = await import("../utils/password.js");
    const passwordHash = await hashPassword(password);

    let user = await prisma.user.findUnique({
      where: { email: invite.email },
    });

    if (user) {
      // Link password if they were OAuth-only
      if (!user.passwordHash) {
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash },
        });
      }
    } else {
      user = await prisma.user.create({
        data: {
          email: invite.email,
          passwordHash,
          name,
        },
      });
    }

    // Add to organization
    await prisma.organizationMember.upsert({
      where: {
        orgId_userId: {
          orgId: invite.orgId,
          userId: user.id,
        },
      },
      create: {
        orgId: invite.orgId,
        userId: user.id,
        role: invite.role,
      },
      update: {}, // Already a member, keep existing role
    });

    // Add to team if specified
    if (invite.teamId) {
      await prisma.teamMember.upsert({
        where: {
          teamId_userId: {
            teamId: invite.teamId,
            userId: user.id,
          },
        },
        create: {
          teamId: invite.teamId,
          userId: user.id,
          role: "MEMBER",
        },
        update: {},
      });

      // Add to team workspaces
      const teamWorkspaces = await prisma.workspace.findMany({
        where: { teamId: invite.teamId },
      });
      if (teamWorkspaces.length > 0) {
        await prisma.workspaceMember.createMany({
          data: teamWorkspaces.map((w) => ({
            workspaceId: w.id,
            userId: user.id,
          })),
          skipDuplicates: true,
        });
      }
    }

    // Mark invite as accepted
    await prisma.invite.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED" },
    });

    // Generate tokens
    const { signAccessToken, createRefreshToken } = await import("../utils/jwt.js");

    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
    });
    const refreshToken = await createRefreshToken(user.id);

    res.status(200).json({
      message: `Joined ${invite.org.name}`,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      organization: {
        id: invite.org.id,
        name: invite.org.name,
        slug: invite.org.slug,
        role: invite.role,
      },
      accessToken,
      refreshToken,
    });
  }
);

// ── GET /invites/validate/:token ───────────────────────────────────

invitesRouter.get(
  "/validate/:token",
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const invite = await prisma.invite.findUnique({
      where: { token: req.params.token },
      include: {
        org: { select: { id: true, name: true, slug: true } },
        team: { select: { id: true, name: true } },
        invitedBy: { select: { name: true, email: true } },
      },
    });

    if (!invite) {
      res.status(404).json({ error: "Invalid invite token" });
      return;
    }

    if (invite.status !== "PENDING") {
      res.status(410).json({ error: `Invite is ${invite.status.toLowerCase()}` });
      return;
    }

    if (invite.expiresAt < new Date()) {
      await prisma.invite.update({
        where: { id: invite.id },
        data: { status: "EXPIRED" },
      });
      res.status(410).json({ error: "Invite has expired" });
      return;
    }

    res.json({
      email: invite.email,
      org: invite.org,
      team: invite.team,
      role: invite.role,
      invitedBy: invite.invitedBy,
      expiresAt: invite.expiresAt,
    });
  }
);

export { router as orgInvitesRouter, invitesRouter };
