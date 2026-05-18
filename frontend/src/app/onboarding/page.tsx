"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import ProgressIndicator from "@/components/onboarding/ProgressIndicator";
import Welcome from "./steps/Welcome";
import CompanyInfo from "./steps/CompanyInfo";
import VisionUpload from "./steps/VisionUpload";
import ModelSelection from "./steps/ModelSelection";
import Integrations from "./steps/Integrations";
import Review from "./steps/Review";
import Processing from "./steps/Processing";
import Complete from "./steps/Complete";
import { ONBOARDING_STEPS, type StepKey, type OnboardingComplete } from "@/lib/types";
import * as api from "@/lib/api";

interface StepData {
  [key: string]: Record<string, unknown>;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [stepData, setStepData] = useState<StepData>({});
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardingComplete | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepKey = ONBOARDING_STEPS[currentStep]?.key;

  const handleStepComplete = useCallback(async (key: StepKey, data: Record<string, unknown>) => {
    setError(null);
    const newStepData = { ...stepData, [key]: data };
    setStepData(newStepData);

    const newCompleted = new Set(completedSteps);
    newCompleted.add(key);
    setCompletedSteps(newCompleted);

    // For company_info step, create the company via API
    if (key === "company_info" && !companyId) {
      setLoading(true);
      try {
        const info = data as { name: string; slug: string; description?: string; industry?: string; size?: string };
        const session = await api.startOnboarding({
          name: info.name,
          slug: info.slug,
          description: info.description,
          industry: info.industry,
          size: info.size,
        });
        setCompanyId(session.company_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create company");
        return;
      } finally {
        setLoading(false);
      }
    }

    // For vision step, upload vision to API
    if (key === "vision" && companyId) {
      setLoading(true);
      try {
        await api.uploadVision(companyId, data.vision_text as string);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save vision");
        return;
      } finally {
        setLoading(false);
      }
    }

    // For models step
    if (key === "models" && companyId) {
      setLoading(true);
      try {
        await api.selectModels(companyId, data.models as Array<{ provider: string; model: string; api_key_set: boolean }>);
      } catch (err) {
        // Non-critical, continue
      } finally {
        setLoading(false);
      }
    }

    // For integrations step
    if (key === "integrations" && companyId) {
      setLoading(true);
      try {
        await api.saveIntegrations(companyId, data.integrations as Record<string, unknown>);
      } catch (err) {
        // Non-critical, continue
      } finally {
        setLoading(false);
      }
    }

    setCurrentStep((prev) => prev + 1);
  }, [stepData, completedSteps, companyId]);

  const handleReviewLaunch = useCallback(async () => {
    if (!companyId) return;
    setError(null);
    setLoading(true);
    setCurrentStep(ONBOARDING_STEPS.findIndex((s) => s.key === "processing"));
  }, [companyId]);

  const handleProcessing = useCallback(async (): Promise<unknown> => {
    if (!companyId) throw new Error("No company ID");
    return api.processOnboarding(companyId);
  }, [companyId]);

  const handleProcessingComplete = useCallback((result: unknown) => {
    setResult(result as OnboardingComplete);
    const completeIdx = ONBOARDING_STEPS.findIndex((s) => s.key === "complete");
    setCurrentStep(completeIdx);
    const newCompleted = new Set(completedSteps);
    newCompleted.add("complete");
    setCompletedSteps(newCompleted);
  }, [completedSteps]);

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    } else {
      router.push("/");
    }
  }, [currentStep, router]);

  const goToStep = useCallback((key: StepKey) => {
    const idx = ONBOARDING_STEPS.findIndex((s) => s.key === key);
    if (idx >= 0 && completedSteps.has(key)) {
      setCurrentStep(idx);
    }
  }, [completedSteps]);

  const renderStep = () => {
    const initialData = stepKey ? stepData[stepKey] || null : null;

    switch (stepKey) {
      case "welcome":
        return <Welcome onNext={() => handleStepComplete("welcome", {})} />;

      case "company_info":
        if (error) {
          return (
            <div className="step-card">
              <p className="text-red-400 mb-4">{error}</p>
              <button onClick={() => setError(null)} className="btn-secondary">Try Again</button>
            </div>
          );
        }
        return (
          <CompanyInfo
            initialData={initialData}
            onNext={(data) => handleStepComplete("company_info", data)}
            onBack={handleBack}
          />
        );

      case "vision":
        return (
          <VisionUpload
            initialData={initialData}
            onNext={(data) => handleStepComplete("vision", data)}
            onBack={handleBack}
          />
        );

      case "models":
        return (
          <ModelSelection
            initialData={initialData}
            onNext={(data) => handleStepComplete("models", data)}
            onBack={handleBack}
          />
        );

      case "integrations":
        return (
          <Integrations
            initialData={initialData}
            onNext={(data) => handleStepComplete("integrations", data)}
            onBack={handleBack}
          />
        );

      case "review":
        return (
          <Review
            stepData={stepData}
            onNext={handleReviewLaunch}
            onBack={handleBack}
          />
        );

      case "processing":
        return (
          <Processing
            processFn={handleProcessing}
            onComplete={handleProcessingComplete}
          />
        );

      case "complete":
        return result ? <Complete result={result} /> : null;

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">
            Create Your AI Company
          </h1>
          <p className="text-gray-500">
            Step {currentStep + 1} of {ONBOARDING_STEPS.length}
          </p>
        </div>

        <ProgressIndicator
          currentStep={currentStep}
          completedSteps={completedSteps}
          onStepClick={goToStep}
        />

        {error && currentStep > 2 && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center">
            {error}
          </div>
        )}

        {renderStep()}
      </div>
    </div>
  );
}
