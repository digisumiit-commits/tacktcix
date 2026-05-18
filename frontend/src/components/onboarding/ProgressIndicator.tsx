"use client";

import { Check } from "lucide-react";
import { ONBOARDING_STEPS, type StepKey } from "@/lib/types";

interface Props {
  currentStep: number;
  completedSteps: Set<string>;
  onStepClick?: (key: StepKey) => void;
}

export default function ProgressIndicator({ currentStep, completedSteps, onStepClick }: Props) {
  return (
    <div className="flex items-center justify-center gap-2 mb-10">
      {ONBOARDING_STEPS.map((step, i) => {
        const isCompleted = completedSteps.has(step.key);
        const isCurrent = i === currentStep;
        const isClickable = isCompleted && onStepClick;

        return (
          <div key={step.key} className="flex items-center gap-2">
            <button
              onClick={() => isClickable && onStepClick?.(step.key)}
              disabled={!isClickable}
              className={`
                w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                transition-all
                ${isCompleted ? "bg-brand-600 text-white cursor-pointer hover:bg-brand-700" : ""}
                ${isCurrent && !isCompleted ? "bg-brand-600/30 text-brand-400 ring-2 ring-brand-500" : ""}
                ${!isCompleted && !isCurrent ? "bg-gray-800 text-gray-600" : ""}
              `}
            >
              {isCompleted ? <Check className="w-4 h-4" /> : step.number}
            </button>
            {i < ONBOARDING_STEPS.length - 1 && (
              <div
                className={`w-6 h-px ${isCompleted ? "bg-brand-600" : "bg-gray-800"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
