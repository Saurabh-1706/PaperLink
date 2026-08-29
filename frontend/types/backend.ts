/**
 * Wire shapes returned by the FastAPI service, verbatim.
 *
 * SOURCE OF TRUTH: `backend/app/schemas/api.py`. Field names stay snake_case on
 * purpose — this file is the contract, not the app's vocabulary. Nothing
 * outside `lib/api/adapters.ts` should import from here; the rest of the app
 * works in the camelCase types in `./pipeline`.
 */

/** Normalised box: `[x1, y1, x2, y2]` in 0..1, origin top-left, relative to the
 *  page's ORIGINAL dimensions (docs/03-coordinate-contract.md). */
export interface BackendBBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Page-anchored box. `page` is **1-based** on the wire. */
export interface BackendRegion {
  page: number;
  bbox: BackendBBox;
}

export interface AssessmentDto {
  id: string;
  title: string;
  status: string;
  question_doc_id: string | null;
  answer_doc_id: string | null;
}

export interface DocumentDto {
  document_id: string;
  kind: "question_paper" | "answer_sheet";
  page_count: number;
  classification: string | null;
  /** false when an identical file was already ingested — uploads are idempotent. */
  created: boolean;
  job_id: string | null;
}

export type JobStage =
  | "ingestion"
  | "extraction"
  | "question_extraction"
  | "answer_extraction"
  | "mapping"
  | "grading"
  | "done";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobDto {
  job_id: string;
  assessment_id: string;
  stage: JobStage;
  status: JobStatus;
  progress: number;
  error: string | null;
}

export interface QuestionDto {
  id: string;
  display_number: string;
  normalized_number: string;
  parent_id: string | null;
  text: string;
  order_index: number;
  optional: boolean;
  max_marks: number | null;
  confidence: number;
  pages: number[];
  regions: BackendRegion[];
}

export interface AnswerDto {
  id: string;
  raw_text: string;
  normalized_text: string;
  detected_label: string | null;
  confidence: number;
  extraction_method: "text" | "ocr";
  is_continuation_of: string | null;
  pages: number[];
  regions: BackendRegion[];
}

export type MappingType = "direct" | "semantic" | "spatial" | "unmatched" | "unanswered";

export type ReviewStatus =
  | "auto_accepted"
  | "needs_review"
  | "human_confirmed"
  | "human_corrected";

export interface MappingDto {
  id: string;
  question_id: string | null;
  answer_id: string | null;
  mapping_type: MappingType;
  confidence: number;
  review_status: ReviewStatus;
  /** Stage scores and the LLM verdict, if any — what makes a low-confidence
   *  mapping reviewable rather than merely doubtful. */
  evidence: Record<string, unknown>;
  regions: BackendRegion[];
}

export interface GradeBreakdownDto {
  name: string;
  awarded: number;
  max_marks: number;
  rationale: string;
}

export interface GradeDto {
  id: string;
  mapping_id: string;
  score: number;
  max_score: number;
  breakdown: GradeBreakdownDto[];
  feedback: string;
  method: "deterministic" | "llm" | "skipped";
}

export interface ResultsDto {
  assessment_id: string;
  mapping_count: number;
  needs_review: number;
  unanswered: number;
  unmatched: number;
  total_score: number;
  max_score: number;
  percentage: number;
}

export interface MappingPatchDto {
  answer_id?: string;
  review_status?: ReviewStatus;
}
