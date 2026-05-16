import type { ApprovalType, RiskLevel } from "@/lib/types";

const typeConfig: Record<ApprovalType, { label: string; icon: string; color: string }> = {
  low_confidence: { label: "Low Confidence", icon: "?", color: "bg-amber-100 text-amber-800 border-amber-200" },
  deployment: { label: "Deployment", icon: "↑", color: "bg-blue-100 text-blue-800 border-blue-200" },
  billing: { label: "Billing", icon: "$", color: "bg-purple-100 text-purple-800 border-purple-200" },
  security: { label: "Security", icon: "!", color: "bg-red-100 text-red-800 border-red-200" },
};

const riskConfig: Record<RiskLevel, { label: string; color: string }> = {
  low: { label: "Low", color: "bg-gray-100 text-gray-700" },
  medium: { label: "Medium", color: "bg-amber-100 text-amber-700" },
  high: { label: "High", color: "bg-orange-100 text-orange-700" },
  critical: { label: "Critical", color: "bg-red-100 text-red-700" },
};

export function ApprovalBadge({ type }: { type: ApprovalType }) {
  const c = typeConfig[type];
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium border ${c.color}`}>
      <span aria-hidden="true">{c.icon}</span>
      {c.label}
    </span>
  );
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  const c = riskConfig[level];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${c.color}`}>
      {c.label}
    </span>
  );
}

export function TimeSince({ iso }: { iso: string }) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return <span>{mins}m ago</span>;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return <span>{hours}h ago</span>;
  const days = Math.floor(hours / 24);
  return <span>{days}d ago</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; color: string }> = {
    pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
    approved: { label: "Approved", color: "bg-emerald-100 text-emerald-800" },
    denied: { label: "Denied", color: "bg-red-100 text-red-800" },
    changes_requested: { label: "Changes Requested", color: "bg-blue-100 text-blue-800" },
  };
  const c = config[status] ?? { label: status, color: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${c.color}`}>
      {c.label}
    </span>
  );
}
