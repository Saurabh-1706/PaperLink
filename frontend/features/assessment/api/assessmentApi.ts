import { proxied, v1 } from "@/lib/api/endpoints";
import { http } from "@/lib/api/httpClient";
import type {
  AnswerDto,
  AssessmentDto,
  DocumentDto,
  GradeDto,
  JobDto,
  MappingDto,
  MappingPatchDto,
  QuestionDto,
  ResultsDto,
} from "@/types/backend";

/**
 * The pipeline, as the UI sees it: one function per FastAPI route.
 *
 * Every call goes through the authenticated proxy (`app/api/backend`), so
 * components never see a bearer token, a backend URL or a response envelope.
 * Returned shapes are the wire DTOs — `lib/api/adapters.ts` converts them.
 */
export const assessmentApi = {
  create: (title: string, signal?: AbortSignal) =>
    http.post<AssessmentDto>(proxied(v1.assessments()), { title }, { signal }),

  get: (assessmentId: string, signal?: AbortSignal) =>
    http.get<AssessmentDto>(proxied(v1.assessment(assessmentId)), { signal }),

  /**
   * Ingestion (render, OCR, IR) runs inside this request and the document plus
   * its binaries are persisted before it returns, so the caller can await it.
   * Re-uploading an identical file returns the existing document with
   * `created: false` rather than re-running OCR.
   */
  uploadQuestionPaper: (assessmentId: string, file: File, signal?: AbortSignal) =>
    upload(v1.questionPaper(assessmentId), file, signal),

  uploadAnswerSheet: (assessmentId: string, file: File, signal?: AbortSignal) =>
    upload(v1.answerSheet(assessmentId), file, signal),

  /** Enqueues the run and returns the job to poll. */
  process: (assessmentId: string, signal?: AbortSignal) =>
    http.post<JobDto>(proxied(v1.process(assessmentId)), undefined, { signal }),

  /** Re-runs mapping and grading only — no re-OCR of a 40-page scan. */
  remap: (assessmentId: string, signal?: AbortSignal) =>
    http.post<JobDto>(proxied(v1.remap(assessmentId)), undefined, { signal }),

  job: (assessmentId: string, jobId: string, signal?: AbortSignal) =>
    http.get<JobDto>(proxied(v1.job(assessmentId, jobId)), { signal }),

  questions: (assessmentId: string, signal?: AbortSignal) =>
    http.get<QuestionDto[]>(proxied(v1.questions(assessmentId)), { signal }),

  answers: (assessmentId: string, signal?: AbortSignal) =>
    http.get<AnswerDto[]>(proxied(v1.answers(assessmentId)), { signal }),

  mappings: (assessmentId: string, signal?: AbortSignal) =>
    http.get<MappingDto[]>(proxied(v1.mappings(assessmentId)), { signal }),

  grades: (assessmentId: string, signal?: AbortSignal) =>
    http.get<GradeDto[]>(proxied(v1.grades(assessmentId)), { signal }),

  results: (assessmentId: string, signal?: AbortSignal) =>
    http.get<ResultsDto>(proxied(v1.results(assessmentId)), { signal }),

  /** A reviewer's correction: reassign the answer, or resolve the flag. */
  patchMapping: (mappingId: string, patch: MappingPatchDto, signal?: AbortSignal) =>
    http.patch<MappingDto>(proxied(v1.mapping(mappingId)), patch, { signal }),
};

function upload(path: string, file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", file, file.name);
  return http.post<DocumentDto>(proxied(path), form, { signal });
}
