// Types for the assessment extraction & mapping pipeline, as the UI speaks it.
//
// The pipeline runs on the FastAPI service and everything it produces is
// persisted (MongoDB + GridFS). These are the camelCase view of the wire shapes
// in ./backend; `lib/api/adapters.ts` is the only thing that converts between
// them. React state here is a cache of a run that exists server-side, not the
// run itself — every record below carries the backend id it came from.

import type { ReviewStatus } from "./backend";

export type { ReviewStatus };

/** One page of a document, as something an `<img>` can render. */
export interface PageImage {
  pageIndex: number; // 0-based index within its source document
  /** URL of the page image rendered by the backend and stored in GridFS,
   *  served through the authenticated proxy. */
  dataUrl: string;
  width: number;
  height: number;
}

/** A single extracted question (labelled sub-parts are separate entries). */
export interface Question {
  id: string; // backend question id
  number: string; // preserves original numbering, e.g. "11(a)"
  text: string;
  marks?: number | null;
  order: number; // printed order, 0-based
  parentId: string | null; // null for top-level questions; set for sub-parts
}

/**
 * A normalized bounding box on one answer-sheet page (fractions 0..1, origin
 * top-left, relative to the page's original dimensions — see
 * docs/03-coordinate-contract.md).
 */
export interface AnswerRegion {
  page: number; // 0-based index into the answer sheet's PageImage[] (the wire is 1-based)
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MappingStatus = "answered" | "unanswered" | "unmatched";

/** Final mapped + graded record joining a question to (maybe) an answer. */
export interface MappedAnswer {
  /** Backend mapping id — what a reviewer correction is PATCHed against. */
  mappingId: string;
  questionId: string | null; // null only for "unmatched" orphan answers
  questionNumber: string | null;
  /** Backend answer id; null when the question went unanswered. */
  answerId: string | null;
  status: MappingStatus;
  /** Whether a human has confirmed or corrected this mapping yet. */
  reviewStatus: ReviewStatus;
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
  /** Mappings the engine flagged; these are never auto-graded. */
  needsReview?: number;
  totalScore: number | null;
  maxScore: number | null;
  overallFeedback?: string;
}

export type ProcessingStage =
  | "idle"
  | "rendering-pages"
  | "extracting-questions"
  | "extracting-answers"
  | "mapping-grading"
  | "done"
  | "error";
