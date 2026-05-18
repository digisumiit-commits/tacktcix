"use client";

interface Props {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onNext?: () => void;
  onBack?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  loading?: boolean;
}

export default function StepContainer({
  title,
  subtitle,
  children,
  onNext,
  onBack,
  nextLabel = "Continue",
  nextDisabled = false,
  loading = false,
}: Props) {
  return (
    <div className="step-card">
      <h2 className="text-2xl font-semibold text-white mb-1">{title}</h2>
      {subtitle && <p className="text-gray-400 mb-6">{subtitle}</p>}

      <div className="mb-8">{children}</div>

      <div className="flex items-center justify-between pt-4 border-t border-gray-800">
        <div>
          {onBack && (
            <button onClick={onBack} className="btn-secondary" disabled={loading}>
              Back
            </button>
          )}
        </div>
        {onNext && (
          <button
            onClick={onNext}
            disabled={nextDisabled || loading}
            className="btn-primary flex items-center gap-2"
          >
            {loading && (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {nextLabel}
          </button>
        )}
      </div>
    </div>
  );
}
