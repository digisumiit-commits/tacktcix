import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import prisma from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireOrgRole } from "../middleware/rbac.js";
import { AuthenticatedRequest, OrgWithRole } from "../types/index.js";
import { OrgRole } from "@prisma/client";

const router = Router();

// ── Validation ────────────────────────────────────────────────────

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(500).optional(),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

const updateMemberRoleSchema = z.object({
  role: z.nativeEnum(OrgRole),
});

// ── Helper ────────────────────────────────────────────────────────

async function buildOrgWithRole(
  orgId: string,
  userId: string
): Promise<OrgWithRole | null> {
  const membership = await prisma.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { org: true },
  });
  if (!membership) return null;

  const memberCount = await prisma.organizationMember.count({
    where: { orgId },
  });

  return {
    id: membership.org.id,
    name: membership.org.name,
    slug: membership.org.slug,
    description: membership.org.description,
    role: membership.role,
    memberCount,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── POST /orgs ────────────────────────────────────────────────────

router.post(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = createOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { name, slug, description } = parsed.data;

    const existing = await prisma.organization.findUnique({
      where: { slug },
    });
    if (existing) {
      res.status(409).json({ error: "Organization slug already taken" });
      return;
    }

    const org = await prisma.organization.create({
      data: {
        name,
        slug,
        description,
        createdById: req.userId!,
        members: {
          create: {
            userId: req.userId!,
            role: "FOUNDER",
          },
        },
      },
    });

    const result = await buildOrgWithRole(org.id, req.userId!);
    res.status(201).json(result);
  }
);

// ── GET /orgs ─────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: req.userId },
      include: {
        org: {
          include: {
            _count: { select: { members: true } },
          },
        },
      },
    });

    const orgs: OrgWithRole[] = memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      description: m.org.description,
      role: m.role,
      memberCount: m.org._count.members,
    }));

    res.json(orgs);
  }
);

// ── GET /orgs/:orgId ──────────────────────────────────────────────

router.get(
  "/:orgId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await buildOrgWithRole(req.params.orgId, req.userId!);
    if (!result) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json(result);
  }
);

// ── PATCH /orgs/:orgId ────────────────────────────────────────────

router.patch(
  "/:orgId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = updateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const org = await prisma.organization.update({
      where: { id: req.params.orgId },
      data: parsed.data,
    });

    const result = await buildOrgWithRole(org.id, req.userId!);
    res.json(result);
  }
);

// ── DELETE /orgs/:orgId ───────────────────────────────────────────

router.delete(
  "/:orgId",
  requireAuth,
  requireOrgRole("FOUNDER"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await prisma.organization.delete({
      where: { id: req.params.orgId },
    });
    res.json({ message: "Organization deleted" });
  }
);

// ── GET /orgs/:orgId/members ──────────────────────────────────────

router.get(
  "/:orgId/members",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const membership = await prisma.organizationMember.findUnique({
      where: {
        orgId_userId: {
          orgId: req.params.orgId,
          userId: req.userId!,
        },
      },
    });
    if (!membership) {
      res.status(403).json({ error: "Not a member of this organization" });
      return;
    }

    const members = await prisma.organizationMember.findMany({
      where: { orgId: req.params.orgId },
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

// ── PATCH /orgs/:orgId/members/:userId/role ───────────────────────

router.patch(
  "/:orgId/members/:userId/role",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = updateMemberRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { role } = parsed.data;

    // Cannot demote/promote a founder (only founder can transfer ownership)
    const targetMembership = await prisma.organizationMember.findUnique({
      where: {
        orgId_userId: {
          orgId: req.params.orgId,
          userId: req.params.userId,
        },
      },
    });

    if (!targetMembership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (targetMembership.role === "FOUNDER") {
      res.status(403).json({ error: "Cannot change the founder's role" });
      return;
    }

    // Cannot assign FOUNDER role (use transfer-ownership)
    if (role === "FOUNDER") {
      res.status(400).json({
        error: "Use the transfer-ownership endpoint to transfer founder role",
      });
      return;
    }

    const updated = await prisma.organizationMember.update({
      where: { id: targetMembership.id },
      data: { role },
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

    res.json({
      id: updated.id,
      userId: updated.user.id,
      email: updated.user.email,
      name: updated.user.name,
      avatarUrl: updated.user.avatarUrl,
      role: updated.role,
      joinedAt: updated.joinedAt,
    });
  }
);

// ── DELETE /orgs/:orgId/members/:userId ───────────────────────────

router.delete(
  "/:orgId/members/:userId",
  requireAuth,
  requireOrgRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const targetMembership = await prisma.organizationMember.findUnique({
      where: {
        orgId_userId: {
          orgId: req.params.orgId,
          userId: req.params.userId,
        },
      },
    });

    if (!targetMembership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (targetMembership.role === "FOUNDER") {
      res.status(403).json({ error: "Cannot remove the founder" });
      return;
    }

    // Remove from all teams and workspaces within the org first
    await prisma.$transaction([
      prisma.teamMember.deleteMany({
        where: {
          userId: req.params.userId,
          team: { orgId: req.params.orgId },
        },
      }),
      prisma.workspaceMember.deleteMany({
        where: {
          userId: req.params.userId,
          workspace: { orgId: req.params.orgId },
        },
      }),
      prisma.organizationMember.delete({
        where: { id: targetMembership.id },
      }),
    ]);

    res.json({ message: "Member removed from organization" });
  }
);

// ── POST /orgs/:orgId/transfer-ownership ──────────────────────────

router.post(
  "/:orgId/transfer-ownership",
  requireAuth,
  requireOrgRole("FOUNDER"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { newOwnerUserId } = req.body;
    if (!newOwnerUserId) {
      res.status(400).json({ error: "newOwnerUserId is required" });
      return;
    }

    const targetMembership = await prisma.organizationMember.findUnique({
      where: {
        orgId_userId: {
          orgId: req.params.orgId,
          userId: newOwnerUserId,
        },
      },
    });

    if (!targetMembership) {
      res.status(404).json({ error: "Target user is not a member of this organization" });
      return;
    }

    await prisma.$transaction([
      prisma.organizationMember.update({
        where: {
          orgId_userId: {
            orgId: req.params.orgId,
            userId: req.userId!,
          },
        },
        data: { role: "ADMIN" },
      }),
      prisma.organizationMember.update({
        where: { id: targetMembership.id },
        data: { role: "FOUNDER" },
      }),
    ]);

    res.json({ message: "Ownership transferred successfully" });
  }
);

export default router;
