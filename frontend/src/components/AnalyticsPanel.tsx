import type { AnalyticsData, ApprovalType } from "@/lib/types";

const typeColors: Record<ApprovalType, string> = {
  low_confidence: "bg-amber-500",
  deployment: "bg-blue-500",
  billing: "bg-purple-500",
  security: "bg-red-500",
};

const typeLabels: Record<ApprovalType, string> = {
  low_confidence: "Low Conf",
  deployment: "Deploy",
  billing: "Billing",
  security: "Security",
};

const agentColors = ["bg-emerald-500", "bg-red-500"];
const agentLabels = ["Approved", "Denied"];

export function AnalyticsPanel({ data }: { data: AnalyticsData }) {
  const maxVolume = Math.max(...data.volumeByDay.map((d) => d.count), 1);
  const maxResTime = Math.max(...data.resolutionTimeByType.map((d) => d.avgMinutes), 1);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Approval volume bar chart */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h4 className="text-sm font-semibold text-gray-900 mb-4">Volume (7 days)</h4>
        <div className="flex items-end justify-between gap-1 h-32">
          {data.volumeByDay.map((d) => {
            const height = (d.count / maxVolume) * 100;
            const isToday = d.date === "Thu";
            return (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1.5">
                <span className="text-xs font-medium text-gray-600">{d.count}</span>
                <div
                  className={`w-full rounded-t-md transition-all ${isToday ? "bg-gray-900" : "bg-gray-200"}`}
                  style={{ height: `${Math.max(height, 4)}%` }}
                  title={`${d.date}: ${d.count}`}
                />
                <span className={`text-xs ${isToday ? "font-semibold text-gray-900" : "text-gray-400"}`}>
                  {d.date}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Resolution time by type */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h4 className="text-sm font-semibold text-gray-900 mb-4">Avg Resolution Time</h4>
        <div className="space-y-3">
          {data.resolutionTimeByType.map((d) => {
            const width = (d.avgMinutes / maxResTime) * 100;
            return (
              <div key={d.type} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-600">{typeLabels[d.type]}</span>
                  <span className="font-medium text-gray-900">{d.avgMinutes}m</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${typeColors[d.type]}`}
                    style={{ width: `${Math.max(width, 4)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Decisions by agent */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h4 className="text-sm font-semibold text-gray-900 mb-4">Decisions by Reviewer</h4>
        <div className="space-y-4">
          {data.decisionsByAgent.map((d) => {
            const total = d.approved + d.denied;
            const approvedPct = total > 0 ? (d.approved / total) * 100 : 0;
            return (
              <div key={d.agent} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-gray-900">{d.agent}</span>
                  <span className="text-gray-500">{total} decisions</span>
                </div>
                <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden flex">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${approvedPct}%` }}
                    title={`${d.approved} approved`}
                  />
                  <div
                    className="h-full bg-red-400 transition-all"
                    style={{ width: `${100 - approvedPct}%` }}
                    title={`${d.denied} denied`}
                  />
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" aria-hidden="true" />
                    {d.approved} approved
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-red-400" aria-hidden="true" />
                    {d.denied} denied
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
