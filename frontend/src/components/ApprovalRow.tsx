import type { Approval } from "@/lib/types";
import { ApprovalBadge, RiskBadge, TimeSince } from "./Badges";

interface ApprovalRowProps {
  approval: Approval;
  isExpanded: boolean;
  onToggle: () => void;
}

const typeIcons: Record<string, string> = {
  low_confidence: "?",
  deployment: "↑",
  billing: "$",
  security: "!",
};

export function ApprovalRow({ approval, isExpanded, onToggle }: ApprovalRowProps) {
  const icon = typeIcons[approval.type] ?? "•";

  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-hidden transition-shadow hover:shadow-md">
      {/* Summary row — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-5 py-4 flex items-center gap-4 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 rounded-xl"
        aria-expanded={isExpanded}
        aria-controls={`approval-detail-${approval.id}`}
      >
        <span
          className="flex-shrink-0 w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-lg font-bold text-gray-600"
          aria-hidden="true"
        >
          {icon}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 truncate">{approval.title}</span>
            <ApprovalBadge type={approval.type} />
            <RiskBadge level={approval.riskLevel} />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {approval.taskIdentifier} · {approval.agentName} · <TimeSince iso={approval.createdAt} />
          </p>
        </div>

        <span className="flex-shrink-0 text-gray-400 text-xs font-medium flex items-center gap-1">
          Review
          <svg
            className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div id={`approval-detail-${approval.id}`} className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-4">
          {/* Agent reasoning */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Agent Reasoning
            </h4>
            <p className="text-sm text-gray-700 leading-relaxed">{approval.reason}</p>
          </div>

          {/* AI Discussion */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              AI Analysis & Discussion
            </h4>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {approval.aiDiscussion}
              </p>
            </div>
          </div>

          {/* Blocked tasks */}
          {approval.blockedTasks.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Blocked Tasks ({approval.blockedTasks.length})
              </h4>
              <div className="flex gap-2 flex-wrap">
                {approval.blockedTasks.map((task) => (
                  <span
                    key={task}
                    className="inline-flex items-center px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-xs font-medium text-amber-800"
                  >
                    {task}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 transition-colors"
              aria-label={`Approve ${approval.title}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Approve
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 text-sm font-semibold hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-2 transition-colors"
              aria-label={`Request changes on ${approval.title}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Request Changes
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-200 bg-white text-red-700 text-sm font-semibold hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-300 focus:ring-offset-2 transition-colors"
              aria-label={`Deny ${approval.title}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Deny
            </button>

            <div className="flex-1" />

            {/* Comment field */}
            <div className="relative flex-1 max-w-xs">
              <input
                type="text"
                placeholder="Add a comment..."
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
