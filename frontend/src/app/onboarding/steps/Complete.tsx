"use client";

import { useRouter } from "next/navigation";
import { CheckCircle, ArrowRight } from "lucide-react";
import type { OnboardingComplete } from "@/lib/types";

interface Props {
  result: OnboardingComplete;
}

export default function Complete({ result }: Props) {
  const router = useRouter();
  const { company } = result;

  return (
    <div className="step-card text-center py-12">
      <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
        <CheckCircle className="w-8 h-8 text-green-400" />
      </div>

      <h2 className="text-2xl font-semibold text-white mb-2">
        {company.name} is Live!
      </h2>
      <p className="text-gray-400 mb-8 max-w-md mx-auto">
        Your AI company has been created with a full knowledge graph, constitution,
        roadmap, architecture plan, agent team, and initial tasks.
      </p>

      <div className="grid grid-cols-2 gap-4 max-w-md mx-auto mb-8">
        <Stat label="Tasks" value={String(result.tasks?.length || 0)} />
        <Stat label="Workflows" value={String(result.workflows?.length || 0)} />
        <Stat label="Agents" value="9" />
        <Stat label="Phases" value="6" />
      </div>

      <button
        onClick={() => router.push(`/dashboard?companyId=${company.id}`)}
        className="btn-primary inline-flex items-center gap-2 text-lg px-8 py-4"
      >
        Go to Dashboard
        <ArrowRight className="w-5 h-5" />
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-700/50">
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
