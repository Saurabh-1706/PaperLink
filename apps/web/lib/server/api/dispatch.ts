/**
 * Internal dispatcher for the routes `app/api/backend/[...path]/route.ts` used to
 * proxy to a separate FastAPI service. There is no separate service anymore — this
 * calls `lib/server` functions directly — but the path shapes, permissions, and JSON
 * contract are exactly what that proxy's allow-list already exposed, so nothing
 * above this layer (httpClient, endpoints.ts, adapters.ts, feature API wrappers, any
 * UI component) needs to change.
 *
 * Routes not yet built (question/answer pipeline, mapping, grading — Phase 2+ in the
 * migration plan) return a typed 501 for actions, or an empty/zeroed DTO for reads,
 * so a assessment page that hasn't been processed yet renders its normal empty state
 * instead of an error.
 */
import { withSession } from "@/lib/server/db/session";
import { getStorage } from "@/lib/server/storage/factory";
import { AssessmentRepository, DocumentRepository, PageRepository } from "@/lib/server/db/repositories";
import { AssessmentService } from "@/lib/server/modules/assessments/service";
import { DocumentService } from "@/lib/server/modules/documents/service";
import { normalizeUploadToPdf } from "@/lib/server/modules/documents/validation";
import { assessmentOut, documentOut } from "./dto";
import type { Principal } from "@/lib/server/auth/principal";
import { NotFoundError, NotImplementedError, ValidationFailedError } from "@/lib/server/errors";

export interface DispatchResult {
  status: number;
  json?: unknown;
  binary?: Buffer;
  contentType?: string;
}

const EMPTY_RESULTS = (assessmentId: string) => ({
  assessment_id: assessmentId,
  mapping_count: 0,
  needs_review: 0,
  unanswered: 0,
  unmatched: 0,
  total_score: 0,
  max_score: 0,
  percentage: 0,
});

export async function dispatch(opts: {
  method: string;
  segments: string[];
  principal: Principal;
  body: unknown; // parsed JSON body, a FormData, or undefined
}): Promise<DispatchResult> {
  const { method, segments, principal, body } = opts;
  const [root, id, sub, subId, tail] = segments;

  if (root === "assessments") {
    if (segments.length === 1 && method === "POST") return createAssessment(principal, body);
    if (segments.length === 2 && method === "GET") return getAssessment(principal, id);

    if (segments.length === 3 && method === "POST" && (sub === "question-paper" || sub === "answer-sheet")) {
      return uploadDocument(principal, id, sub === "question-paper" ? "question_paper" : "answer_sheet", body);
    }
    if (segments.length === 3 && method === "POST" && (sub === "process" || sub === "remap")) {
      throw new NotImplementedError(
        "Question/answer extraction, mapping and grading ship in a later phase of the Next.js migration."
      );
    }
    if (segments.length === 4 && method === "GET" && sub === "jobs") {
      throw new NotFoundError("No such job.", { jobId: subId });
    }
    if (segments.length === 3 && method === "GET" && (sub === "questions" || sub === "answers" || sub === "mappings" || sub === "grades")) {
      await withSession(async (session) => {
        await new AssessmentRepository(session).getOrThrow(principal.organizationId, id);
      });
      return { status: 200, json: [] };
    }
    if (segments.length === 3 && method === "GET" && sub === "results") {
      await withSession(async (session) => {
        await new AssessmentRepository(session).getOrThrow(principal.organizationId, id);
      });
      return { status: 200, json: EMPTY_RESULTS(id) };
    }
  }

  if (root === "documents") {
    if (segments.length === 5 && method === "GET" && sub === "pages" && tail === "image") {
      return pageImage(principal, id, Number(subId));
    }
    if (segments.length === 3 && method === "GET" && sub === "markdown") {
      return documentMarkdown(principal, id);
    }
  }

  if (root === "mappings" && segments.length === 2 && method === "PATCH") {
    throw new NotImplementedError("Mapping review ships with the mapping engine in a later phase.");
  }

  throw new NotFoundError("No such endpoint.");
}

async function createAssessment(principal: Principal, body: unknown): Promise<DispatchResult> {
  const title = (body as { title?: unknown })?.title;
  if (typeof title !== "string" || !title.trim()) {
    throw new ValidationFailedError("title is required.");
  }
  const assessment = await withSession((session) =>
    new AssessmentService(session).create(principal.organizationId, principal.userId, title.trim())
  );
  return { status: 201, json: assessmentOut(assessment) };
}

async function getAssessment(principal: Principal, id: string): Promise<DispatchResult> {
  const assessment = await withSession((session) =>
    new AssessmentRepository(session).getOrThrow(principal.organizationId, id)
  );
  return { status: 200, json: assessmentOut(assessment) };
}

async function uploadDocument(
  principal: Principal,
  assessmentId: string,
  kind: "question_paper" | "answer_sheet",
  body: unknown
): Promise<DispatchResult> {
  if (!(body instanceof FormData)) {
    throw new ValidationFailedError("Expected a multipart/form-data upload.");
  }
  const files = body.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new ValidationFailedError("No file was uploaded.");

  const uploads = await Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    }))
  );
  const { data } = await normalizeUploadToPdf(uploads);

  const result = await withSession(async (session) => {
    const assessment = await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const storage = getStorage(session);
    const documents = new DocumentService(session, storage);
    const ingestResult = await documents.ingest({
      organizationId: principal.organizationId,
      assessmentId: assessment.id,
      kind,
      data,
      createdBy: principal.userId,
    });
    await new AssessmentService(session).attachDocument(assessment, kind, ingestResult.document.id);
    return ingestResult;
  });

  return { status: 202, json: documentOut(result.document, result.created) };
}

async function pageImage(principal: Principal, documentId: string, pageNumber: number): Promise<DispatchResult> {
  const image = await withSession(async (session) => {
    await new DocumentRepository(session).getOrThrow(principal.organizationId, documentId);
    const page = await new PageRepository(session).byNumber(principal.organizationId, documentId, pageNumber);
    if (!page || !page.renderedImageUri) {
      throw new NotFoundError("Page image not found.", { documentId, pageNumber });
    }
    return getStorage(session).get(page.renderedImageUri, principal.organizationId);
  });
  return { status: 200, binary: image, contentType: "image/png" };
}

async function documentMarkdown(principal: Principal, documentId: string): Promise<DispatchResult> {
  const markdown = await withSession(async (session) => {
    const document = await new DocumentRepository(session).getOrThrow(principal.organizationId, documentId);
    if (!document.markdownUri) throw new NotFoundError("Markdown not available.", { documentId });
    return getStorage(session).get(document.markdownUri, principal.organizationId);
  });
  return { status: 200, binary: markdown, contentType: "text/markdown" };
}
