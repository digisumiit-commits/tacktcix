import type { ApprovalType } from "@/lib/types";

interface FilterBarProps {
  selectedTypes: ApprovalType[];
  onTypeToggle: (type: ApprovalType) => void;
  selectedRisk: string | null;
  onRiskChange: (risk: string | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

const typeOptions: { value: ApprovalType; label: string }[] = [
  { value: "low_confidence", label: "Low Confidence" },
  { value: "deployment", label: "Deployment" },
  { value: "billing", label: "Billing" },
  { value: "security", label: "Security" },
];

const riskOptions = [
  { value: "", label: "All Risks" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

export function FilterBar({
  selectedTypes,
  onTypeToggle,
  selectedRisk,
  onRiskChange,
  search,
  onSearchChange,
}: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 flex-wrap">
      {/* Type filters */}
      <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter by approval type">
        {typeOptions.map((opt) => {
          const active = selectedTypes.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onTypeToggle(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                active
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:bg-gray-50"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Risk filter */}
      <select
        value={selectedRisk ?? ""}
        onChange={(e) => onRiskChange(e.target.value || null)}
        className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
        aria-label="Filter by risk level"
      >
        {riskOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      {/* Search */}
      <div className="relative flex-1 min-w-[200px] max-w-xs">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search approvals..."
          className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
          aria-label="Search approvals"
        />
      </div>
    </div>
  );
}
