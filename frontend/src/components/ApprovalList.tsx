"use client";

import { useState } from "react";
import type { Approval } from "@/lib/types";
import { ApprovalRow } from "./ApprovalRow";

export function ApprovalList({ approvals }: { approvals: Approval[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  return (
    <div className="space-y-3" role="list" aria-label="Pending approvals">
      {approvals.map((approval) => (
        <div key={approval.id} role="listitem">
          <ApprovalRow
            approval={approval}
            isExpanded={expandedId === approval.id}
            onToggle={() => setExpandedId(expandedId === approval.id ? null : approval.id)}
          />
        </div>
      ))}
    </div>
  );
}
