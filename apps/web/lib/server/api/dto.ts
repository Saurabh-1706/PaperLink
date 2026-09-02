/**
 * Wire-shape builders. Field names are snake_case on purpose — this is the same
 * contract `frontend/types/backend.ts` already declares (SOURCE OF TRUTH there), now
 * produced directly instead of proxied from FastAPI.
 */
import type { Assessment, Document } from "@/lib/server/db/models";

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
