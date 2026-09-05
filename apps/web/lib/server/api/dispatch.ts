/**
 * Internal dispatcher for the routes `app/api/backend/[...path]/route.ts` used to
 * proxy to a separate FastAPI service. There is no separate service anymore — this
 * calls `lib/server` functions directly — but the path shapes, permissions, and JSON
 * contract are exactly what that proxy's allow-list already exposed, so nothing
 * above this layer (httpClient, endpoints.ts, adapters.ts, feature API wrappers, any
 * UI component) needs to change.
 */
import { withSession } from "@/lib/server/db/session";
import { getStorage } from "@/lib/server/storage/factory";
import {
  AnswerRegionRepository,
  AnswerRepository,
  AssessmentRepository,
  DocumentRepository,
  GradeRepository,
  JobRepository,
  MappingRepository,
  PageRepository,
  QuestionRegionRepository,
  QuestionRepository,
} from "@/lib/server/db/repositories";
import { AssessmentService } from "@/lib/server/modules/assessments/service";
import { AssessmentProcessingService } from "@/lib/server/modules/assessments/processing";
import { DocumentService } from "@/lib/server/modules/documents/service";
import { normalizeUploadToPdf } from "@/lib/server/modules/documents/validation";
import { assessmentSummary } from "@/lib/server/modules/grading/engine";
import { answerRegions } from "./regions";
import { answerOut, assessmentOut, documentOut, gradeOut, jobOut, mappingOut, questionOut, resultsOut } from "./dto";
import type { Principal } from "@/lib/server/auth/principal";
import { NotFoundError, ValidationFailedError } from "@/lib/server/errors";

export interface DispatchResult {
  status: number;
  json?: unknown;
  binary?: Buffer;
  contentType?: string;
}

const REVIEW_STATUSES = new Set(["auto_accepted", "needs_review", "human_confirmed", "human_corrected"]);

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
      return processAssessment(principal, id, sub === "remap");
    }
    if (segments.length === 4 && method === "GET" && sub === "jobs") {
      return jobStatus(principal, id, subId);
    }
    if (segments.length === 3 && method === "GET" && sub === "questions") return listQuestions(principal, id);
    if (segments.length === 3 && method === "GET" && sub === "answers") return listAnswers(principal, id);
    if (segments.length === 3 && method === "GET" && sub === "mappings") return listMappings(principal, id);
    if (segments.length === 3 && method === "GET" && sub === "grades") return listGrades(principal, id);
    if (segments.length === 3 && method === "GET" && sub === "results") return getResults(principal, id);
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
    return correctMapping(principal, id, body);
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

/**
 * Job creation is its own committed transaction, then the pipeline runs in a
 * second one — `AssessmentProcessingService.process()` never throws (a failure is
 * recorded on the job and swallowed, see processing.ts), so this always returns a
 * job the client can read, whether it ended up queued-then-succeeded or failed.
 */
async function processAssessment(principal: Principal, assessmentId: string, remapOnly: boolean): Promise<DispatchResult> {
  const job = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const processing = new AssessmentProcessingService(session, getStorage(session));
    return processing.createJob(principal.organizationId, assessmentId, principal.userId);
  });

  await withSession(async (session) => {
    const processing = new AssessmentProcessingService(session, getStorage(session));
    await processing.process(principal.organizationId, assessmentId, job.id, remapOnly);
  });

  const finalJob = await withSession((session) => new JobRepository(session).getOrThrow(principal.organizationId, job.id));
  return { status: 202, json: jobOut(finalJob) };
}

async function jobStatus(principal: Principal, assessmentId: string, jobId: string): Promise<DispatchResult> {
  const job = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    return new JobRepository(session).getOrThrow(principal.organizationId, jobId);
  });
  return { status: 200, json: jobOut(job) };
}

async function listQuestions(principal: Principal, assessmentId: string): Promise<DispatchResult> {
  const json = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const rows = await new QuestionRepository(session).forAssessment(principal.organizationId, assessmentId);
    const regionRows = await new QuestionRegionRepository(session).forQuestions(principal.organizationId, rows.map((r) => r.id));
    const grouped = new Map<string, Array<{ page: number; bbox: { x1: number; y1: number; x2: number; y2: number } }>>();
    for (const region of regionRows) {
      const list = grouped.get(region.questionId) ?? [];
      list.push({ page: region.pageNumber, bbox: { x1: region.bbox[0], y1: region.bbox[1], x2: region.bbox[2], y2: region.bbox[3] } });
      grouped.set(region.questionId, list);
    }
    return rows.map((row) => questionOut(row, grouped.get(row.id) ?? []));
  });
  return { status: 200, json };
}

async function listAnswers(principal: Principal, assessmentId: string): Promise<DispatchResult> {
  const json = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const rows = await new AnswerRepository(session).forAssessment(principal.organizationId, assessmentId);
    const regionRows = await new AnswerRegionRepository(session).forAnswers(principal.organizationId, rows.map((r) => r.id));
    const grouped = new Map<string, Array<{ page: number; bbox: { x1: number; y1: number; x2: number; y2: number } }>>();
    for (const region of regionRows) {
      const list = grouped.get(region.answerId) ?? [];
      list.push({ page: region.pageNumber, bbox: { x1: region.bbox[0], y1: region.bbox[1], x2: region.bbox[2], y2: region.bbox[3] } });
      grouped.set(region.answerId, list);
    }
    return rows.map((row) => answerOut(row, grouped.get(row.id) ?? []));
  });
  return { status: 200, json };
}

async function listMappings(principal: Principal, assessmentId: string): Promise<DispatchResult> {
  const json = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const rows = await new MappingRepository(session).forAssessment(principal.organizationId, assessmentId);
    // Multi-page answers own regions on their continuation rows too.
    const grouped = await answerRegions(session, principal.organizationId, assessmentId);
    return rows.map((row) => mappingOut(row, grouped.get(row.answerId ?? "") ?? []));
  });
  return { status: 200, json };
}

async function listGrades(principal: Principal, assessmentId: string): Promise<DispatchResult> {
  const json = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const rows = await new MappingRepository(session).forAssessment(principal.organizationId, assessmentId);
    const grades = await new GradeRepository(session).forMappings(principal.organizationId, rows.map((r) => r.id));
    return grades.map(gradeOut);
  });
  return { status: 200, json };
}

async function getResults(principal: Principal, assessmentId: string): Promise<DispatchResult> {
  const json = await withSession(async (session) => {
    await new AssessmentRepository(session).getOrThrow(principal.organizationId, assessmentId);
    const rows = await new MappingRepository(session).forAssessment(principal.organizationId, assessmentId);
    const grades = await new GradeRepository(session).forMappings(principal.organizationId, rows.map((r) => r.id));
    const summary = assessmentSummary(grades.map((g) => ({ method: g.method, score: g.score, maxScore: g.maxScore })));
    return resultsOut(assessmentId, rows, summary);
  });
  return { status: 200, json };
}

async function correctMapping(principal: Principal, mappingId: string, body: unknown): Promise<DispatchResult> {
  const payload = (body ?? {}) as { answer_id?: unknown; review_status?: unknown };
  const json = await withSession(async (session) => {
    const mappings = new MappingRepository(session);
    const row = await mappings.getOrThrow(principal.organizationId, mappingId);

    if (payload.answer_id !== undefined && payload.answer_id !== null) {
      if (typeof payload.answer_id !== "string") throw new ValidationFailedError("answer_id must be a string.");
      const answer = await new AnswerRepository(session).getOrThrow(principal.organizationId, payload.answer_id);
      if (answer.assessmentId !== row.assessmentId) {
        throw new ValidationFailedError("The answer belongs to a different assessment.");
      }
      row.answerId = answer.id;
      row.reviewStatus = "human_corrected";
      if (row.questionId && row.mappingType === "unanswered") row.mappingType = "direct";
    } else if (payload.review_status !== undefined && payload.review_status !== null) {
      if (typeof payload.review_status !== "string" || !REVIEW_STATUSES.has(payload.review_status)) {
        throw new ValidationFailedError("Unknown review_status.", { value: payload.review_status });
      }
      row.reviewStatus = payload.review_status;
    } else {
      throw new ValidationFailedError("Provide answer_id or review_status.");
    }

    row.evidence = { ...(row.evidence || {}), corrected_by: principal.userId };
    await session.flush();

    const grouped = await answerRegions(session, principal.organizationId, row.assessmentId);
    return mappingOut(row, grouped.get(row.answerId ?? "") ?? []);
  });
  return { status: 200, json };
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
