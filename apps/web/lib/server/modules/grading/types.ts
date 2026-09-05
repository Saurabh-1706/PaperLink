/** Port of the grading-related parts of backend/app/schemas/pipeline.py. */
export interface RubricCriterion {
  name: string;
  weight: number;
  keywords: string[];
  maxMarks: number | null;
}

export interface Rubric {
  criteria: RubricCriterion[];
}

export interface CriterionScore {
  name: string;
  awarded: number;
  maxMarks: number;
  rationale: string;
}

export interface Grade {
  questionId: string | null;
  answerId: string | null;
  score: number;
  maxScore: number;
  breakdown: CriterionScore[];
  feedback: string;
  /** "deterministic" | "llm" | "skipped" | "provisional" */
  method: string;
  skippedReason: string | null;
}
