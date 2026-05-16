import type { ActivityEvent } from "@/lib/types";
import { TimeSince } from "./Badges";

const actionConfig: Record<string, { label: string; color: string }> = {
  approved: { label: "Approved", color: "bg-emerald-100 text-emerald-800" },
  denied: { label: "Denied", color: "bg-red-100 text-red-800" },
  changes_requested: { label: "Changes Requested", color: "bg-blue-100 text-blue-800" },
  commented: { label: "Commented", color: "bg-gray-100 text-gray-700" },
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">Recent Activity</h3>
      </div>
      <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
        {events.map((event) => {
          const c = actionConfig[event.action] ?? actionConfig.commented;
          return (
            <div key={event.id} className="px-5 py-3.5 hover:bg-gray-50 transition-colors">
              <div className="flex items-start gap-3">
                <span
                  className={`flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${c.color}`}
                >
                  {c.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 truncate font-medium">
                    {event.approvalTitle}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {event.actorName} · <TimeSince iso={event.timestamp} />
                  </p>
                  {event.comment && (
                    <p className="text-xs text-gray-600 mt-1.5 leading-relaxed italic">
                      &ldquo;{event.comment}&rdquo;
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
