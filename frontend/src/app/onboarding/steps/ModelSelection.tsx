"use client";

import { useState } from "react";
import { Cpu, Check } from "lucide-react";
import StepContainer from "@/components/onboarding/StepContainer";

interface Props {
  initialData: Record<string, unknown> | null;
  onNext: (data: Record<string, unknown>) => void;
  onBack: () => void;
}

const AVAILABLE_MODELS = [
  {
    provider: "deepseek",
    model: "deepseek-chat",
    label: "DeepSeek Chat",
    description: "General-purpose reasoning and code generation. Default model.",
    recommended: true,
  },
  {
    provider: "deepseek",
    model: "deepseek-coder",
    label: "DeepSeek Coder",
    description: "Specialized for code generation and debugging tasks.",
  },
  {
    provider: "openai",
    model: "gpt-4o",
    label: "OpenAI GPT-4o",
    description: "Multimodal reasoning. Requires separate API key.",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    description: "Best-in-class coding and analysis. Requires separate API key.",
  },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Large context window. Requires separate API key.",
  },
  {
    provider: "openrouter",
    model: "auto",
    label: "OpenRouter (Auto)",
    description: "Auto-routes to best available model. Requires OpenRouter API key.",
  },
];

export default function ModelSelection({ initialData, onNext, onBack }: Props) {
  const initialModels = (initialData?.models as string[]) || ["deepseek/deepseek-chat"];
  const [selected, setSelected] = useState<Set<string>>(new Set(initialModels));

  const toggleModel = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelected(next);
  };

  const selectedModels = Array.from(selected).map((key) => {
    const [provider, model] = key.split("/");
    return { provider, model, api_key_set: provider === "deepseek" };
  });

  return (
    <StepContainer
      title="Select AI Models"
      subtitle="Choose which AI models your agents can use. You can change this later."
      onNext={() => onNext({ models: selectedModels })}
      onBack={onBack}
      nextDisabled={selected.size === 0}
      nextLabel="Continue"
    >
      <div className="space-y-3">
        {AVAILABLE_MODELS.map((m) => {
          const key = `${m.provider}/${m.model}`;
          const isSelected = selected.has(key);

          return (
            <button
              key={key}
              onClick={() => toggleModel(key)}
              className={`w-full text-left p-4 rounded-xl border transition-all ${
                isSelected
                  ? "border-brand-500 bg-brand-500/10"
                  : "border-gray-700/50 bg-gray-800/30 hover:border-gray-600"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-all ${
                  isSelected ? "bg-brand-600 border-brand-600" : "border-gray-600"
                }`}>
                  {isSelected && <Check className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-brand-400 flex-shrink-0" />
                    <span className="font-medium text-white text-sm">{m.label}</span>
                    {m.recommended && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-brand-600/20 text-brand-400 rounded-full">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{m.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </StepContainer>
  );
}
