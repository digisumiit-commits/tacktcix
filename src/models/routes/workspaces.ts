import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireOrgRole } from "../middleware/rbac.js";
import { AuthenticatedRequest } from "../types/index.js";

const router = Router({ mergeParams: true });

// ── Validation ────────────────────────────────────────────────────

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  teamId: z.string().uuid().optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

// ── POST /orgs/:orgId/workspaces ──────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { name, description, teamId } = parsed.data;

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

    const workspace = await prisma.workspace.create({
      data: {
        name,
        description,
        orgId: req.params.orgId,
        teamId: teamId || null,
        createdById: req.userId!,
        members: {
          create: {
            userId: req.userId!,
          },
        },
      },
      include: {
        team: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });

    // If team-scoped, auto-add all team members
    if (teamId) {
      const teamMembers = await prisma.teamMember.findMany({
        where: { teamId },
      });
      const memberIds = teamMembers
        .map((m) => m.userId)
        .filter((id) => id !== req.userId);

      if (memberIds.length > 0) {
        await prisma.workspaceMember.createMany({
          data: memberIds.map((userId) => ({
            workspaceId: workspace.id,
            userId,
          })),
          skipDuplicates: true,
        });
      }
    }

    res.status(201).json(workspace);
  }
);

// ── GET /orgs/:orgId/workspaces ───────────────────────────────────

router.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { teamId } = req.query;
    const where: Record<string, unknown> = { orgId: req.params.orgId };
    if (typeof teamId === "string") where.teamId = teamId;

    const workspaces = await prisma.workspace.findMany({
      where,
      include: {
        team: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(workspaces);
  }
);

// ── GET /orgs/:orgId/workspaces/:workspaceId ──────────────────────

router.get(
  "/:workspaceId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const workspace = await prisma.workspace.findUnique({
      where: {
        id: req.params.workspaceId,
        orgId: req.params.orgId,
      },
      include: {
        team: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });

    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.json(workspace);
  }
);

// ── PATCH /orgs/:orgId/workspaces/:workspaceId ────────────────────

router.patch(
  "/:workspaceId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = updateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const workspace = await prisma.workspace.update({
      where: {
        id: req.params.workspaceId,
        orgId: req.params.orgId,
      },
      data: parsed.data,
      include: {
        team: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });

    res.json(workspace);
  }
);

// ── DELETE /orgs/:orgId/workspaces/:workspaceId ───────────────────

router.delete(
  "/:workspaceId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await prisma.workspace.delete({
      where: {
        id: req.params.workspaceId,
        orgId: req.params.orgId,
      },
    });
    res.json({ message: "Workspace deleted" });
  }
);

// ── GET /orgs/:orgId/workspaces/:workspaceId/members ──────────────

router.get(
  "/:workspaceId/members",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: req.params.workspaceId },
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
        joinedAt: m.joinedAt,
      }))
    );
  }
);

// ── POST /orgs/:orgId/workspaces/:workspaceId/members ─────────────

router.post(
  "/:workspaceId/members",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

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

    const existing = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: req.params.workspaceId,
          userId,
        },
      },
    });
    if (existing) {
      res.status(409).json({ error: "User is already a workspace member" });
      return;
    }

    const member = await prisma.workspaceMember.create({
      data: {
        workspaceId: req.params.workspaceId,
        userId,
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

    res.status(201).json({
      id: member.id,
      userId: member.user.id,
      email: member.user.email,
      name: member.user.name,
      avatarUrl: member.user.avatarUrl,
      joinedAt: member.joinedAt,
    });
  }
);

// ── DELETE /orgs/:orgId/workspaces/:workspaceId/members/:userId ───

router.delete(
  "/:workspaceId/members/:userId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: req.params.workspaceId,
          userId: req.params.userId,
        },
      },
    });

    if (!membership) {
      res.status(404).json({ error: "Workspace member not found" });
      return;
    }

    await prisma.workspaceMember.delete({
      where: { id: membership.id },
    });

    res.json({ message: "Workspace member removed" });
  }
);

export default router;
