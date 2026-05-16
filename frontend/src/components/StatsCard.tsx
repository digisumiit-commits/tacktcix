import type { DashboardStats } from "@/lib/types";

interface StatsCardProps {
  label: string;
  value: string | number;
  delta?: string;
  icon: string;
  accent: "neutral" | "amber" | "emerald" | "blue";
}

const accentStyles: Record<StatsCardProps["accent"], { bg: string; text: string; border: string }> = {
  neutral: { bg: "bg-gray-50", text: "text-gray-900", border: "border-gray-200" },
  amber: { bg: "bg-amber-50", text: "text-amber-900", border: "border-amber-200" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-900", border: "border-emerald-200" },
  blue: { bg: "bg-blue-50", text: "text-blue-900", border: "border-blue-200" },
};

export function StatsCard({ label, value, delta, icon, accent }: StatsCardProps) {
  const s = accentStyles[accent];
  return (
    <div className={`rounded-xl border ${s.border} ${s.bg} p-5 flex flex-col gap-2`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-600">{label}</span>
        <span className="text-lg leading-none" aria-hidden="true">{icon}</span>
      </div>
      <p className={`text-2xl font-bold tracking-tight ${s.text}`}>{value}</p>
      {delta && <p className="text-xs text-gray-500">{delta}</p>}
    </div>
  );
}

export function StatsRow({ stats }: { stats: DashboardStats }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatsCard
        label="Pending"
        value={stats.pendingCount}
        delta="6 new today"
        icon="⏳"
        accent="amber"
      />
      <StatsCard
        label="Resolved Today"
        value={stats.resolvedToday}
        delta="+12% vs yesterday"
        icon="✓"
        accent="emerald"
      />
      <StatsCard
        label="Avg Response Time"
        value={`${stats.avgResponseTimeMinutes}m`}
        delta="−0.4m from last week"
        icon="⚡"
        accent="blue"
      />
      <StatsCard
        label="Approval Rate"
        value={`${stats.approvalRate}%`}
        delta="+2% vs last week"
        icon="📊"
        accent="neutral"
      />
    </div>
  );
}
