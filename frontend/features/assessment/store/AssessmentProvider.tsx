"use client";

import { createContext, useContext } from "react";
import { useAssessmentPipeline, type AssessmentPipeline } from "../hooks/useAssessmentPipeline";

const AssessmentContext = createContext<AssessmentPipeline | null>(null);

/**
 * Holds one in-flight assessment run. Nothing is persisted server-side, so the
 * run lives here for the lifetime of the mounted route.
 */
export function AssessmentProvider({ children }: { children: React.ReactNode }) {
  const pipeline = useAssessmentPipeline();
  return <AssessmentContext.Provider value={pipeline}>{children}</AssessmentContext.Provider>;
}

export function useAssessment(): AssessmentPipeline {
  const ctx = useContext(AssessmentContext);
  if (!ctx) throw new Error("useAssessment must be used inside <AssessmentProvider>.");
  return ctx;
}
