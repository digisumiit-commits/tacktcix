import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireOrgRole } from "../middleware/rbac.js";
import { AuthenticatedRequest } from "../types/index.js";

const router = Router({ mergeParams: true });

// ── Validation ────────────────────────────────────────────────────

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

// ── POST /orgs/:orgId/teams ───────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const team = await prisma.team.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        orgId: req.params.orgId,
        createdById: req.userId!,
        members: {
          create: {
            userId: req.userId!,
            role: "LEAD",
          },
        },
      },
      include: {
        _count: { select: { members: true, workspaces: true } },
      },
    });

    res.status(201).json(team);
  }
);

// ── GET /orgs/:orgId/teams ────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const teams = await prisma.team.findMany({
      where: { orgId: req.params.orgId },
      include: {
        _count: { select: { members: true, workspaces: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(teams);
  }
);

// ── GET /orgs/:orgId/teams/:teamId ────────────────────────────────

router.get(
  "/:teamId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const team = await prisma.team.findUnique({
      where: { id: req.params.teamId, orgId: req.params.orgId },
      include: {
        _count: { select: { members: true, workspaces: true } },
      },
    });

    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    res.json(team);
  }
);

// ── PATCH /orgs/:orgId/teams/:teamId ──────────────────────────────

router.patch(
  "/:teamId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = updateTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const team = await prisma.team.update({
      where: { id: req.params.teamId, orgId: req.params.orgId },
      data: parsed.data,
      include: {
        _count: { select: { members: true, workspaces: true } },
      },
    });

    res.json(team);
  }
);

// ── DELETE /orgs/:orgId/teams/:teamId ─────────────────────────────

router.delete(
  "/:teamId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await prisma.team.delete({
      where: { id: req.params.teamId, orgId: req.params.orgId },
    });
    res.json({ message: "Team deleted" });
  }
);

// ── GET /orgs/:orgId/teams/:teamId/members ────────────────────────

router.get(
  "/:teamId/members",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const members = await prisma.teamMember.findMany({
      where: { teamId: req.params.teamId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });

    res.json(
      members.map((m) => ({
        id: m.id,
        userId: m.user.id,
        email: m.user.email,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        joinedAt: m.joinedAt,
      }))
    );
  }
);

// ── POST /orgs/:orgId/teams/:teamId/members ───────────────────────

router.post(
  "/:teamId/members",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    // Verify user is an org member
    const orgMember = await prisma.organizationMember.findUnique({
      where: {
        orgId_userId: {
          orgId: req.params.orgId,
          userId,
        },
      },
    });
    if (!orgMember) {
      res.status(400).json({ error: "User is not a member of this organization" });
      return;
    }

    const existing = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: req.params.teamId,
          userId,
        },
      },
    });
    if (existing) {
      res.status(409).json({ error: "User is already a team member" });
      return;
    }

    const member = await prisma.teamMember.create({
      data: {
        teamId: req.params.teamId,
        userId,
        role: "MEMBER",
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });

    // Also add to all team workspaces
    const teamWorkspaces = await prisma.workspace.findMany({
      where: { teamId: req.params.teamId },
    });
    if (teamWorkspaces.length > 0) {
      await prisma.workspaceMember.createMany({
        data: teamWorkspaces.map((w) => ({
          workspaceId: w.id,
          userId,
        })),
        skipDuplicates: true,
      });
    }

    res.status(201).json({
      id: member.id,
      userId: member.user.id,
      email: member.user.email,
      name: member.user.name,
      avatarUrl: member.user.avatarUrl,
      role: member.role,
      joinedAt: member.joinedAt,
    });
  }
);

// ── DELETE /orgs/:orgId/teams/:teamId/members/:userId ─────────────

router.delete(
  "/:teamId/members/:userId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: req.params.teamId,
          userId: req.params.userId,
        },
      },
    });

    if (!membership) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }

    // Remove from team workspaces
    await prisma.$transaction([
      prisma.workspaceMember.deleteMany({
        where: {
          userId: req.params.userId,
          workspace: { teamId: req.params.teamId },
        },
      }),
      prisma.teamMember.delete({ where: { id: membership.id } }),
    ]);

    res.json({ message: "Team member removed" });
  }
);

export default router;
