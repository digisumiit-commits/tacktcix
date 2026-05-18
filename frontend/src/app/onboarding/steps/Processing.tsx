"use client";

import { useEffect, useState } from "react";
import { Brain, FileText, GitBranch, ListTodo, Workflow, Rocket } from "lucide-react";

interface Props {
  onComplete: (result: unknown) => void;
  processFn: () => Promise<unknown>;
}

const STAGES = [
  { key: "vision", label: "Analyzing vision document...", icon: Brain },
  { key: "knowledge_graph", label: "Building knowledge graph...", icon: GitBranch },
  { key: "constitution", label: "Generating company constitution...", icon: FileText },
  { key: "roadmap", label: "Creating phased roadmap...", icon: ListTodo },
  { key: "architecture", label: "Designing architecture plan...", icon: Workflow },
  { key: "tasks", label: "Generating initial tasks and workflows...", icon: Rocket },
];

export default function Processing({ onComplete, processFn }: Props) {
  const [currentStage, setCurrentStage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Advance through stages with visual feedback
      for (let i = 0; i < STAGES.length; i++) {
        if (cancelled) return;
        setCurrentStage(i);
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 400));
      }

      try {
        const result = await processFn();
        if (!cancelled) {
          setCurrentStage(STAGES.length);
          await new Promise((r) => setTimeout(r, 600));
          onComplete(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Processing failed");
        }
      }
    }

    run();
    return () => { cancelled = true; };
  }, [processFn, onComplete]);

  return (
    <div className="step-card text-center py-16">
      {error ? (
        <div>
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <Rocket className="w-8 h-8 text-red-400" />
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Processing Error</h2>
          <p className="text-red-400 text-sm mb-6">{error}</p>
          <button onClick={() => window.location.reload()} className="btn-secondary">
            Try Again
          </button>
        </div>
      ) : (
        <div>
          <div className="w-20 h-20 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-6 animate-pulse">
            <Brain className="w-10 h-10 text-brand-400" />
          </div>

          <h2 className="text-xl font-semibold text-white mb-6">
            {currentStage < STAGES.length ? "Building Your AI Company" : "Company Ready!"}
          </h2>

          <div className="space-y-3 max-w-sm mx-auto">
            {STAGES.map((stage, i) => {
              const isDone = i < currentStage;
              const isCurrent = i === currentStage;

              return (
                <div
                  key={stage.key}
                  className={`flex items-center gap-3 text-left p-2 rounded-lg transition-all ${
                    isCurrent ? "bg-brand-500/10" : ""
                  }`}
                >
                  <stage.icon
                    className={`w-5 h-5 flex-shrink-0 ${
                      isDone ? "text-green-400" : isCurrent ? "text-brand-400 animate-pulse" : "text-gray-600"
                    }`}
                  />
                  <span
                    className={`text-sm ${
                      isDone ? "text-green-400" : isCurrent ? "text-brand-300" : "text-gray-600"
                    }`}
                  >
                    {stage.label}
                  </span>
                  {isDone && <span className="ml-auto text-green-400 text-xs">Done</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
