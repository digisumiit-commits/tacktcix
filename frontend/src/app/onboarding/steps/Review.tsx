"use client";

import StepContainer from "@/components/onboarding/StepContainer";

interface Props {
  stepData: Record<string, Record<string, unknown>>;
  onNext: () => void;
  onBack: () => void;
}

export default function Review({ stepData, onNext, onBack }: Props) {
  const companyInfo = stepData.company_info || {};
  const vision = stepData.vision || {};
  const models = stepData.models || {};
  const integrations = stepData.integrations || {};

  return (
    <StepContainer
      title="Review & Launch"
      subtitle="Review your company configuration before processing."
      onNext={onNext}
      onBack={onBack}
      nextLabel="Launch Company"
    >
      <div className="space-y-4">
        <Section title="Company">
          <Field label="Name" value={companyInfo.name as string} />
          <Field label="Industry" value={companyInfo.industry as string} />
          <Field label="Size" value={companyInfo.size as string} />
          <Field label="Description" value={companyInfo.description as string} />
        </Section>

        <Section title="Vision">
          <Field label="Length" value={vision.vision_text ? `${(vision.vision_text as string).split(/\s+/).length} words` : "Not provided"} />
          {vision.vision_text && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-3">{(vision.vision_text as string).slice(0, 300)}...</p>
          )}
        </Section>

        <Section title="AI Models">
          {((models.models as unknown[]) || []).length > 0 ? (
            <ul className="space-y-1">
              {(models.models as Array<{ provider: string; model: string }>).map((m) => (
                <li key={`${m.provider}/${m.model}`} className="text-sm text-gray-400">
                  {m.provider} / {m.model}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">None selected</p>
          )}
        </Section>

        <Section title="Integrations">
          {Object.keys(integrations.integrations as Record<string, unknown> || {}).length > 0 ? (
            <ul className="space-y-1">
              {Object.entries(integrations.integrations as Record<string, unknown> || {}).map(([key]) => (
                <li key={key} className="text-sm text-gray-400 capitalize">{key}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">None connected</p>
          )}
        </Section>
      </div>
    </StepContainer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800/30 rounded-xl p-4 border border-gray-700/50">
      <h3 className="text-sm font-medium text-gray-300 mb-2">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-300">{value}</span>
    </div>
  );
}
