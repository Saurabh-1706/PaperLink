/**
 * Wire-shape builders. Field names are snake_case on purpose — this is the same
 * contract `frontend/types/backend.ts` already declares (SOURCE OF TRUTH there), now
 * produced directly instead of proxied from FastAPI.
 */
import type { Answer, GradeRow, Job, MappingRow, Question, Assessment, Document } from "@/lib/server/db/models";
import type { Region } from "@/lib/server/modules/common";
import type { AssessmentSummary } from "@/lib/server/modules/grading/engine";

export function assessmentOut(assessment: Assessment) {
  return {
    id: assessment.id,
    title: assessment.title,
    status: assessment.status,
    question_doc_id: assessment.questionDocId,
    answer_doc_id: assessment.answerDocId,
  };
}

export function documentOut(document: Document, created: boolean) {
  return {
    document_id: document.id,
    kind: document.kind,
    page_count: document.pageCount,
    classification: document.classification,
    created,
    job_id: null,
  };
}

export function jobOut(job: Job) {
  return {
    job_id: job.id,
    assessment_id: job.assessmentId,
    stage: job.stage,
    status: job.status,
    progress: job.progress,
    error: job.error,
  };
}

function regionOut(region: Region) {
  return { page: region.page, bbox: { x1: region.bbox.x1, y1: region.bbox.y1, x2: region.bbox.x2, y2: region.bbox.y2 } };
}

export function questionOut(row: Question, regions: Region[]) {
  return {
    id: row.id,
    display_number: row.displayNumber,
    normalized_number: row.normalizedNumber,
    parent_id: row.parentId,
    text: row.text,
    order_index: row.orderIndex,
    optional: row.optional,
    max_marks: row.maxMarks,
    confidence: row.confidence,
    pages: [...new Set(regions.map((r) => r.page))].sort((a, b) => a - b),
    regions: regions.map(regionOut),
  };
}

export function answerOut(row: Answer, regions: Region[]) {
  return {
    id: row.id,
    raw_text: row.rawText,
    normalized_text: row.normalizedText,
    detected_label: row.detectedLabel,
    confidence: row.confidence,
    extraction_method: row.extractionMethod,
    is_continuation_of: row.isContinuationOf,
    pages: [...new Set(regions.map((r) => r.page))].sort((a, b) => a - b),
    regions: regions.map(regionOut),
  };
}

export function mappingOut(row: MappingRow, regions: Region[]) {
  return {
    id: row.id,
    question_id: row.questionId,
    answer_id: row.answerId,
    mapping_type: row.mappingType,
    confidence: row.confidence,
    review_status: row.reviewStatus,
    evidence: row.evidence || {},
    regions: regions.map(regionOut),
  };
}

export function gradeOut(row: GradeRow) {
  const breakdown = ((row.rubric as { breakdown?: unknown[] } | null)?.breakdown ?? []) as Array<{
    name: string;
    awarded: number;
    maxMarks: number;
    rationale: string;
  }>;
  return {
    id: row.id,
    mapping_id: row.mappingId,
    score: row.score,
    max_score: row.maxScore,
    breakdown: breakdown.map((item) => ({
      name: item.name,
      awarded: item.awarded,
      max_marks: item.maxMarks,
      rationale: item.rationale,
    })),
    feedback: row.feedback,
    method: row.method,
  };
}

/**
 * `mapping_count`/`needs_review`/`unanswered`/`unmatched` come straight from the
 * mapping rows (port of AssessmentService.results()); `total_score`/`max_score`/
 * `percentage` come from `assessmentSummary()`'s *filtered* aggregation — the fix
 * described in ADR-007: the old Python `/results` endpoint summed every grade
 * including provisional/skipped ones, contradicting CLAUDE.md's own invariant that
 * an unconfirmed mapping's grade never counts toward the reported score.
 */
export function resultsOut(assessmentId: string, mappingRows: MappingRow[], summary: AssessmentSummary) {
  return {
    assessment_id: assessmentId,
    mapping_count: mappingRows.length,
    needs_review: mappingRows.filter((r) => r.reviewStatus === "needs_review").length,
    unanswered: mappingRows.filter((r) => r.mappingType === "unanswered").length,
    unmatched: mappingRows.filter((r) => r.mappingType === "unmatched").length,
    total_score: summary.totalScore,
    max_score: summary.maxScore,
    percentage: summary.percentage,
  };
}
