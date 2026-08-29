// Shared types for the assessment extraction & mapping pipeline.
// Everything lives in-memory on the client (React state) for the lifetime of
// a session — nothing is persisted server-side, per the assignment's
// "no database / in-memory is sufficient" constraint.

/** One page rendered to a base64 image (JPEG, size-capped — see lib/pdf.ts), ready to send to a vision model. */
export interface PageImage {
  pageIndex: number; // 0-based index within its source document
  dataUrl: string; // "data:image/jpeg;base64,...."
  width: number;
  height: number;
}

/** A single extracted question (labelled sub-parts are separate entries). */
export interface Question {
  id: string; // stable client-generated id
  number: string; // preserves original numbering, e.g. "11(a)"
  text: string;
  marks?: number | null;
  order: number; // printed order, 0-based
}

/** A normalized bounding box on one answer-sheet page (fractions 0..1). */
export interface AnswerRegion {
  page: number; // 0-based index into the answer sheet's PageImage[]
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One block of handwritten answer content the model found on the answer
 * sheet. `questionNumber` is the model's best reading of the label the
 * student wrote (or null if illegible/absent) *before* mapping is applied.
 */
export interface RawAnswerBlock {
  id: string;
  questionNumberGuess: string | null;
  confidence: number;
  text: string;
  regions: AnswerRegion[]; // can span multiple pages
}

export type MappingStatus = "answered" | "unanswered" | "unmatched";

/** Final mapped + graded record joining a question to (maybe) an answer. */
export interface MappedAnswer {
  questionId: string | null; // null only for "unmatched" orphan answers
  questionNumber: string | null;
  status: MappingStatus;
  answerText?: string;
  regions?: AnswerRegion[];
  isCorrect?: boolean | null;
  score?: number | null;
  maxScore?: number | null;
  feedback?: string;
  confidence?: number; // 0..1, model's confidence in this mapping
}

export interface GradingSummary {
  totalQuestions: number;
  answered: number;
  unanswered: number;
  unmatched: number;
  totalScore: number | null;
  maxScore: number | null;
  overallFeedback?: string;
}

export interface ProcessResult {
  questions: Question[];
  mappings: MappedAnswer[];
  summary: GradingSummary;
}

export type ProcessingStage =
  | "idle"
  | "rendering-pages"
  | "extracting-questions"
  | "extracting-answers"
  | "mapping-grading"
  | "done"
  | "error";
