"use client";

import { useState } from "react";
import StepContainer from "@/components/onboarding/StepContainer";

interface Props {
  initialData: Record<string, unknown> | null;
  onNext: (data: Record<string, unknown>) => void;
  onBack: () => void;
}

export default function CompanyInfo({ initialData, onNext, onBack }: Props) {
  const [name, setName] = useState((initialData?.name as string) || "");
  const [description, setDescription] = useState((initialData?.description as string) || "");
  const [industry, setIndustry] = useState((initialData?.industry as string) || "");
  const [size, setSize] = useState((initialData?.size as string) || "");

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <StepContainer
      title="Tell us about your company"
      subtitle="Basic information to get started."
      onNext={() => onNext({ name, slug, description, industry, size })}
      onBack={onBack}
      nextDisabled={!name.trim()}
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Company Name *</label>
          <input
            className="input-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme AI Corp"
            autoFocus
          />
          {name && (
            <p className="text-xs text-gray-500 mt-1">URL slug: {slug}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Short Description</label>
          <textarea
            className="input-field min-h-[80px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does your company do in one sentence?"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Industry</label>
            <select
              className="input-field"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            >
              <option value="">Select...</option>
              <option value="saas">SaaS</option>
              <option value="fintech">Fintech</option>
              <option value="healthtech">Healthtech</option>
              <option value="ecommerce">E-commerce</option>
              <option value="ai_ml">AI / Machine Learning</option>
              <option value="developer_tools">Developer Tools</option>
              <option value="enterprise">Enterprise</option>
              <option value="consumer">Consumer</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Company Size</label>
            <select
              className="input-field"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              <option value="">Select...</option>
              <option value="solo">Solo Founder</option>
              <option value="2-5">2-5 people</option>
              <option value="6-20">6-20 people</option>
              <option value="21-100">21-100 people</option>
              <option value="100+">100+ people</option>
            </select>
          </div>
        </div>
      </div>
    </StepContainer>
  );
}
