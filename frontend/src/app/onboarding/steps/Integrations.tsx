"use client";

import { useState } from "react";
import { Github, Globe, MessageCircle } from "lucide-react";
import StepContainer from "@/components/onboarding/StepContainer";

interface Props {
  initialData: Record<string, unknown> | null;
  onNext: (data: Record<string, unknown>) => void;
  onBack: () => void;
}

const INTEGRATION_OPTIONS = [
  {
    key: "github",
    icon: Github,
    label: "GitHub",
    description: "Connect repositories for code generation and deployment.",
    fields: [{ key: "token", label: "GitHub Token", type: "password", placeholder: "ghp_..." }],
  },
  {
    key: "vercel",
    icon: Globe,
    label: "Vercel",
    description: "Deploy frontend applications automatically.",
    fields: [{ key: "token", label: "Vercel Token", type: "password", placeholder: "..." }],
  },
  {
    key: "slack",
    icon: MessageCircle,
    label: "Slack",
    description: "Receive notifications about deployments and approvals.",
    fields: [{ key: "webhook_url", label: "Webhook URL", type: "text", placeholder: "https://hooks.slack.com/..." }],
  },
];

export default function Integrations({ initialData, onNext, onBack }: Props) {
  const [integrations, setIntegrations] = useState<Record<string, Record<string, string>>>(
    (initialData as Record<string, Record<string, string>>) || {}
  );

  const updateField = (integrationKey: string, fieldKey: string, value: string) => {
    setIntegrations((prev) => ({
      ...prev,
      [integrationKey]: { ...(prev[integrationKey] || {}), [fieldKey]: value },
    }));
  };

  return (
    <StepContainer
      title="Connect Integrations"
      subtitle="Connect the tools your AI agents will use. You can skip and configure later."
      onNext={() => onNext({ integrations })}
      onBack={onBack}
      nextLabel="Continue"
    >
      <div className="space-y-4">
        {INTEGRATION_OPTIONS.map((integration) => (
          <div key={integration.key} className="bg-gray-800/30 rounded-xl p-4 border border-gray-700/50">
            <div className="flex items-center gap-3 mb-3">
              <integration.icon className="w-5 h-5 text-gray-400" />
              <div>
                <h4 className="text-sm font-medium text-white">{integration.label}</h4>
                <p className="text-xs text-gray-500">{integration.description}</p>
              </div>
            </div>
            {integration.fields.map((field) => (
              <div key={field.key} className="mt-2">
                <label className="block text-xs text-gray-500 mb-1">{field.label}</label>
                <input
                  type={field.type}
                  className="input-field text-sm"
                  value={integrations[integration.key]?.[field.key] || ""}
                  onChange={(e) => updateField(integration.key, field.key, e.target.value)}
                  placeholder={field.placeholder}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </StepContainer>
  );
}
