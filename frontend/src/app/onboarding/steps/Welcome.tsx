"use client";

import { Zap, Shield, Brain, Rocket } from "lucide-react";
import StepContainer from "@/components/onboarding/StepContainer";

interface Props {
  onNext: () => void;
}

const features = [
  { icon: Brain, title: "AI-Native", description: "Autonomous AI agents run engineering, design, QA, and operations under your governance." },
  { icon: Shield, title: "Zero Infra", description: "No VPS, Docker, or Kubernetes knowledge needed. We handle all infrastructure." },
  { icon: Zap, title: "Instant Setup", description: "Answer a few questions about your vision and get a fully structured AI company in minutes." },
  { icon: Rocket, title: "Ready to Ship", description: "Your company launches with a constitution, roadmap, agent team, and initial tasks." },
];

export default function Welcome({ onNext }: Props) {
  return (
    <StepContainer
      title="Welcome to TACKTCIX"
      subtitle="The AI-native company operating system. Let's build your company."
      onNext={onNext}
      nextLabel="Get Started"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {features.map((f) => (
          <div key={f.title} className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
            <f.icon className="w-6 h-6 text-brand-400 mb-2" />
            <h3 className="font-medium text-white text-sm mb-1">{f.title}</h3>
            <p className="text-gray-400 text-xs leading-relaxed">{f.description}</p>
          </div>
        ))}
      </div>
    </StepContainer>
  );
}
