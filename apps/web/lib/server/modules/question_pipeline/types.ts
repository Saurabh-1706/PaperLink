/** Port of the question-related parts of backend/app/schemas/pipeline.py. */
import type { Region } from "../common";

export interface ExtractedQuestion {
  questionId: string;
  /** Verbatim as printed: "11 (a)". */
  displayNumber: string;
  /** Sortable canonical form: "11.a". */
  normalizedNumber: string;
  /** normalizedNumber of the parent, if nested. */
  parentNumber: string | null;
  text: string;
  pages: number[];
  regions: Region[];
  orderIndex: number;
  optional: boolean;
  maxMarks: number | null;
  confidence: number;
  blockIds: string[];
}

export interface QuestionPipelineResult {
  questions: ExtractedQuestion[];
  ambiguities: string[];
  orphanBlockIds: string[];
  usedLlm: boolean;
}
