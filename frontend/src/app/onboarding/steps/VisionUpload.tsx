"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import StepContainer from "@/components/onboarding/StepContainer";

interface Props {
  initialData: Record<string, unknown> | null;
  onNext: (data: Record<string, unknown>) => void;
  onBack: () => void;
}

export default function VisionUpload({ initialData, onNext, onBack }: Props) {
  const [vision, setVision] = useState((initialData?.vision_text as string) || "");

  const wordCount = vision.trim() ? vision.trim().split(/\s+/).length : 0;

  return (
    <StepContainer
      title="Your Vision"
      subtitle="Describe your company's vision in detail. The more you share, the better your AI company will be structured."
      onNext={() => onNext({ vision_text: vision })}
      onBack={onBack}
      nextDisabled={wordCount < 15}
      nextLabel="Analyze Vision"
    >
      <div className="space-y-4">
        <div className="relative">
          <textarea
            className="input-field min-h-[240px] font-mono text-sm leading-relaxed"
            value={vision}
            onChange={(e) => setVision(e.target.value)}
            placeholder={`Describe your company vision here...

What problem are you solving?
Who are your users?
What makes your approach unique?
What features are critical?
What's your business model?
What's your timeline?`}
            autoFocus
          />
          {!vision && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center text-gray-600">
                <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Paste or type your vision document</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">
            {wordCount} words
          </span>
          {wordCount > 0 && wordCount < 15 && (
            <span className="text-amber-400">
              Please write at least 15 words to continue
            </span>
          )}
          {wordCount >= 15 && (
            <span className="text-green-400">
              Ready to analyze
            </span>
          )}
        </div>

        <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
          <h4 className="text-sm font-medium text-gray-300 mb-2">Tips for a great vision:</h4>
          <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
            <li>Be specific about the problem and solution</li>
            <li>Mention your target users and market</li>
            <li>Describe key features and technical requirements</li>
            <li>Include your business model and growth strategy</li>
            <li>Share your timeline and priorities</li>
          </ul>
        </div>
      </div>
    </StepContainer>
  );
}
