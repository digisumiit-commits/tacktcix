import { Request } from "express";
import { OrgRole, TeamRole } from "@prisma/client";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export interface OrgMembership {
  orgId: string;
  role: OrgRole;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    googleId: string | null;
    githubId: string | null;
  };
  accessToken: string;
  refreshToken: string;
}

export interface OrgWithRole {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: OrgRole;
  memberCount: number;
}

export { OrgRole, TeamRole };
