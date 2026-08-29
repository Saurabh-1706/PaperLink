import { proxied, v1 } from "./endpoints";
import type {
  AnswerDto,
  BackendRegion,
  GradeDto,
  JobStage,
  MappingDto,
  QuestionDto,
  ResultsDto,
} from "@/types/backend";
import type {
  AnswerRegion,
  GradingSummary,
  MappedAnswer,
  PageImage,
  ProcessingStage,
  Question,
} from "@/types";

/**
 * The seam between the backend's contract and the app's vocabulary.
 *
 * Two conversions matter and both happen here, once:
 *
 *  1. **Boxes.** The wire carries `bbox: {x1,y1,x2,y2}` (docs/03-coordinate-contract.md);
 *     the canvas positions absolutely and wants `{x, y, width, height}`.
 *  2. **Page numbers.** The backend is 1-based; `PageImage[]` is indexed from 0.
 *
 * Doing this anywhere else would put two page-numbering conventions in the same
 * component, which is exactly the bug that is impossible to see in a diff.
 */

export function toAnswerRegion(region: BackendRegion): AnswerRegion {
  const { x1, y1, x2, y2 } = region.bbox;
  return {
    page: region.page - 1,
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

export function toQuestion(dto: QuestionDto): Question {
  return {
    id: dto.id,
    number: dto.display_number,
    text: dto.text,
    marks: dto.max_marks,
    order: dto.order_index,
  };
}

/** `direct` / `semantic` / `spatial` all mean the question got an answer. */
function toStatus(dto: MappingDto): MappedAnswer["status"] {
  if (dto.mapping_type === "unanswered") return "unanswered";
  if (dto.mapping_type === "unmatched") return "unmatched";
  return "answered";
}

/**
 * A mark is only "correct"/"incorrect" at the extremes; partial credit is
 * neither, and an ungraded mapping stays null so the UI shows it as pending
 * rather than as a zero the teacher never awarded.
 */
function toCorrectness(grade: GradeDto | undefined): boolean | null {
  if (!grade || grade.method === "skipped" || grade.max_score <= 0) return null;
  if (grade.score >= grade.max_score) return true;
  if (grade.score <= 0) return false;
  return null;
}

export function toMappedAnswer(
  dto: MappingDto,
  context: {
    questionsById: Map<string, QuestionDto>;
    answersById: Map<string, AnswerDto>;
    gradesByMapping: Map<string, GradeDto>;
  }
): MappedAnswer {
  const question = dto.question_id ? context.questionsById.get(dto.question_id) : undefined;
  const answer = dto.answer_id ? context.answersById.get(dto.answer_id) : undefined;
  const grade = context.gradesByMapping.get(dto.id);

  return {
    mappingId: dto.id,
    questionId: dto.question_id,
    questionNumber: question?.display_number ?? answer?.detected_label ?? null,
    answerId: dto.answer_id,
    status: toStatus(dto),
    reviewStatus: dto.review_status,
    answerText: answer?.raw_text,
    // The mapping's own regions already fold in every continuation page of the
    // answer (backend/app/api/v1/regions.py), so a multi-page answer arrives whole.
    regions: dto.regions.map(toAnswerRegion),
    isCorrect: toCorrectness(grade),
    score: grade ? grade.score : null,
    maxScore: grade ? grade.max_score : (question?.max_marks ?? null),
    feedback: grade?.feedback,
    confidence: dto.confidence,
  };
}

export function toGradingSummary(results: ResultsDto, questionCount: number): GradingSummary {
  const answered = Math.max(
    0,
    results.mapping_count - results.unanswered - results.unmatched
  );
  return {
    totalQuestions: questionCount,
    answered,
    unanswered: results.unanswered,
    unmatched: results.unmatched,
    needsReview: results.needs_review,
    totalScore: results.total_score,
    maxScore: results.max_score,
  };
}

/**
 * Page images are served from GridFS by the backend and reached through the
 * authenticated proxy, so `dataUrl` is a URL the `<img>` loads directly — the
 * bytes never pass through React state. Backend page numbers are 1-based.
 */
export function toPageImages(documentId: string, pageCount: number): PageImage[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    pageIndex: index,
    dataUrl: proxied(v1.pageImage(documentId, index + 1)),
    width: 0,
    height: 0,
  }));
}

/**
 * Backend job stages collapse onto the four the progress UI knows about.
 * Ingestion covers upload, render and OCR — all of it is "reading the pages".
 */
const STAGE_BY_JOB_STAGE: Record<JobStage, ProcessingStage> = {
  ingestion: "rendering-pages",
  extraction: "rendering-pages",
  question_extraction: "extracting-questions",
  answer_extraction: "extracting-answers",
  mapping: "mapping-grading",
  grading: "mapping-grading",
  done: "done",
};

export function toProcessingStage(stage: JobStage): ProcessingStage {
  return STAGE_BY_JOB_STAGE[stage] ?? "rendering-pages";
}
