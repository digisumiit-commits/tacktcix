export type ApprovalType =
  | "low_confidence"
  | "deployment"
  | "billing"
  | "security";

export type ApprovalStatus = "pending" | "approved" | "denied" | "changes_requested";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface Approval {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  riskLevel: RiskLevel;
  title: string;
  taskId: string;
  taskIdentifier: string;
  agentName: string;
  agentRole: string;
  reason: string;
  aiDiscussion: string;
  createdAt: string;
  updatedAt: string;
  blockedTasks: string[];
}

export interface ActivityEvent {
  id: string;
  approvalId: string;
  approvalTitle: string;
  action: "approved" | "denied" | "changes_requested" | "commented";
  actorName: string;
  actorRole: string;
  comment?: string;
  timestamp: string;
}

export interface DashboardStats {
  pendingCount: number;
  resolvedToday: number;
  avgResponseTimeMinutes: number;
  approvalRate: number;
  byType: Record<ApprovalType, number>;
  byRisk: Record<RiskLevel, number>;
}

export interface AnalyticsData {
  volumeByDay: { date: string; count: number }[];
  resolutionTimeByType: { type: ApprovalType; avgMinutes: number }[];
  decisionsByAgent: { agent: string; approved: number; denied: number }[];
}
