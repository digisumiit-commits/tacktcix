import { Response, NextFunction } from "express";
import { OrgRole } from "@prisma/client";
import prisma from "../utils/prisma.js";
import { AuthenticatedRequest } from "../types/index.js";

const ROLE_HIERARCHY: Record<OrgRole, number> = {
  FOUNDER: 5,
  ADMIN: 4,
  DEVELOPER: 3,
  OPERATOR: 2,
  OBSERVER: 1,
};

export function requireOrgRole(minRole: OrgRole) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const orgId = req.params.orgId || req.body.orgId;
    if (!orgId) {
      res.status(400).json({ error: "Organization ID is required" });
      return;
    }

    const membership = await prisma.organizationMember.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId: req.userId!,
        },
      },
    });

    if (!membership) {
      res.status(403).json({ error: "Not a member of this organization" });
      return;
    }

    if (ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY[minRole]) {
      res.status(403).json({
        error: `Requires ${minRole} role or higher`,
      });
      return;
    }

    next();
  };
}

export function requireTeamRole(minRole: "LEAD" | "MEMBER") {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const teamId = req.params.teamId || req.body.teamId;
    if (!teamId) {
      res.status(400).json({ error: "Team ID is required" });
      return;
    }

    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId,
          userId: req.userId!,
        },
      },
    });

    if (!membership) {
      res.status(403).json({ error: "Not a member of this team" });
      return;
    }

    if (minRole === "LEAD" && membership.role !== "LEAD") {
      res.status(403).json({ error: "Requires team lead role" });
      return;
    }

    next();
  };
}
