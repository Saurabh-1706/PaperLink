/**
 * Assessment processing: connects the three graphs to persistence. Port of the
 * pipeline-orchestration parts of backend/app/modules/assessments/service.py
 * (kept separate from the CRUD-only `AssessmentService` in service.ts, whose own
 * header comment already flags this split).
 *
 * Stage order is fixed and each stage advances `jobs`, so a slow OCR pass is
 * observable — a `Job` row is written and updated stage-by-stage, though because
 * every write in one `process()` call shares a single MongoDB transaction
 * (db/session.ts), a concurrent poll of that job only ever observes it before the
 * attempt started or after it finished, never mid-flight. `process`/`remap` are
 * therefore run synchronously inside the request that triggers them (matching how
 * document upload/OCR already works, and the Python system's own default
 * `CELERY_TASK_ALWAYS_EAGER=true`) rather than backed by a queue.
 */
import { AppError, NotFoundError } from "@/lib/server/errors";
import { newOrgOwned } from "@/lib/server/db/base";
import type { UnitOfWork } from "@/lib/server/db/session";
import { withSession } from "@/lib/server/db/session";
import { GridFSStorage } from "@/lib/server/storage/gridfs";
import {
  AnswerRegionRepository,
  AnswerRepository,
  AssessmentRepository,
  DocumentRepository,
  GradeRepository,
  JobRepository,
  MappingRepository,
  QuestionRegionRepository,
  QuestionRepository,
} from "@/lib/server/db/repositories";
import type { Answer, Assessment, GradeRow, Job, MappingRow, Question } from "@/lib/server/db/models";
import { DocumentService } from "@/lib/server/modules/documents/service";
import { runQuestionGraph } from "@/lib/server/graphs/question_graph";
import { runAnswerGraph } from "@/lib/server/graphs/answer_graph";
import { runMappingGraph } from "@/lib/server/graphs/mapping_graph";
import { defaultMappingConfig } from "@/lib/server/modules/mapping_engine/engine";
import type { Mapping } from "@/lib/server/modules/mapping_engine/types";
import { gradeAssessment } from "@/lib/server/modules/grading/engine";
import type { Grade } from "@/lib/server/modules/grading/types";
import { mergeContinuations } from "@/lib/server/modules/answer_pipeline/pipeline";
import type { ExtractedAnswer } from "@/lib/server/modules/answer_pipeline/types";
import type { ExtractedQuestion } from "@/lib/server/modules/question_pipeline/types";
import type { Region } from "@/lib/server/modules/common";
import { validateMapping } from "@/lib/server/ai/mappingValidation";
import { gradeWithLlm } from "@/lib/server/ai/gradingLlm";

export class AssessmentProcessingService {
  private assessments: AssessmentRepository;
  private documents: DocumentRepository;
  private questions: QuestionRepository;
  private questionRegions: QuestionRegionRepository;
  private answers: AnswerRepository;
  private answerRegions: AnswerRegionRepository;
  private mappings: MappingRepository;
  private grades: GradeRepository;
  private jobs: JobRepository;
  private documentService: DocumentService;

  constructor(private session: UnitOfWork, storage: GridFSStorage) {
    this.assessments = new AssessmentRepository(session);
    this.documents = new DocumentRepository(session);
    this.questions = new QuestionRepository(session);
    this.questionRegions = new QuestionRegionRepository(session);
    this.answers = new AnswerRepository(session);
    this.answerRegions = new AnswerRegionRepository(session);
    this.mappings = new MappingRepository(session);
    this.grades = new GradeRepository(session);
    this.jobs = new JobRepository(session);
    this.documentService = new DocumentService(session, storage);
  }

  // ---------------------------------------------------------------------------- jobs
  async createJob(organizationId: string, assessmentId: string, createdBy: string | null): Promise<Job> {
    const job: Job = {
      ...newOrgOwned(organizationId, createdBy),
      assessmentId,
      stage: "ingestion",
      status: "queued",
      progress: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.add(job);
    await this.session.flush();
    return job;
  }

  private async advance(job: Job, stage: Job["stage"], progress: number): Promise<void> {
    job.stage = stage;
    job.status = "running";
    job.progress = progress;
    if (job.startedAt === null) job.startedAt = new Date();
    await this.session.flush();
  }

  // ---------------------------------------------------------------------- processing
  /**
   * Run the pipeline. Returns true on success; a failure is recorded on the job
   * (typed code + message) rather than thrown, so the client can poll for it
   * instead of losing it to a rollback.
   */
  async process(
    organizationId: string,
    assessmentId: string,
    jobId: string,
    remapOnly: boolean
  ): Promise<boolean> {
    const job = await this.jobs.getOrThrow(organizationId, jobId);
    const assessment = await this.assessments.getOrThrow(organizationId, assessmentId);
    try {
      if (remapOnly) {
        await this.runMappingAndGrading(organizationId, assessment, job);
      } else {
        await this.runFull(organizationId, assessment, job);
      }
      job.status = "succeeded";
      job.stage = "done";
      job.progress = 1.0;
      job.finishedAt = new Date();
      assessment.status = "processed";
      await this.session.flush();
      return true;
    } catch (err) {
      // Discard every write this attempt made (including earlier, already-flushed
      // stages) — a failed run is all-or-nothing except for the job's own failure
      // record, written separately below so it survives the rollback.
      await this.session.rollback();
      await recordJobFailure(organizationId, jobId, err);
      return false;
    }
  }

  private async runFull(organizationId: string, assessment: Assessment, job: Job): Promise<void> {
    if (!assessment.questionDocId || !assessment.answerDocId) {
      throw new NotFoundError("Both a question paper and an answer sheet are required.");
    }

    await this.advance(job, "question_extraction", 0.2);
    const questionDoc = await this.documents.getOrThrow(organizationId, assessment.questionDocId);
    const questionIr = await this.documentService.loadIr(questionDoc);
    const questionResult = await runQuestionGraph(questionIr);
    await this.storeQuestions(organizationId, assessment, questionResult.questions);

    await this.advance(job, "answer_extraction", 0.5);
    const answerDoc = await this.documents.getOrThrow(organizationId, assessment.answerDocId);
    const answerIr = await this.documentService.loadIr(answerDoc);
    const pageImages = await this.documentService.pageImages(organizationId, answerDoc);
    const answerResult = await runAnswerGraph(answerIr, pageImages);
    await this.storeAnswers(organizationId, assessment, answerResult.answers);

    await this.runMappingAndGrading(organizationId, assessment, job);
  }

  private async runMappingAndGrading(organizationId: string, assessment: Assessment, job: Job): Promise<void> {
    await this.advance(job, "mapping", 0.75);
    const questions = await this.loadQuestions(organizationId, assessment.id);
    const answers = await this.loadAnswers(organizationId, assessment.id);
    const mappingResult = await runMappingGraph(questions, answers, validateMapping, defaultMappingConfig());
    await this.storeMappings(organizationId, assessment, mappingResult.mappings);

    await this.advance(job, "grading", 0.9);
    const questionsById = new Map(questions.map((q) => [q.questionId, q]));
    const answersById = new Map(mergeContinuations(answers).map((a) => [a.answerId, a]));
    const grades = await gradeAssessment(mappingResult.mappings, questionsById, answersById, undefined, gradeWithLlm);
    await this.storeGrades(organizationId, assessment, grades);
  }

  // ------------------------------------------------------------------------ storage
  private async storeQuestions(
    organizationId: string,
    assessment: Assessment,
    questions: ExtractedQuestion[]
  ): Promise<void> {
    const removedIds = await this.questions.clearForAssessment(organizationId, assessment.id);
    await this.questionRegions.clearForQuestions(organizationId, removedIds);
    await this.session.flush();

    const rowsByNumber = new Map<string, Question>();
    for (const question of questions) {
      const row: Question = {
        ...newOrgOwned(organizationId, assessment.createdBy),
        assessmentId: assessment.id,
        externalId: question.questionId,
        displayNumber: question.displayNumber,
        normalizedNumber: question.normalizedNumber,
        parentId: null,
        text: question.text,
        orderIndex: question.orderIndex,
        optional: question.optional,
        maxMarks: question.maxMarks,
        confidence: question.confidence,
      };
      this.questions.add(row);
      rowsByNumber.set(question.normalizedNumber, row);
      for (const region of question.regions) {
        this.questionRegions.add({
          ...newOrgOwned(organizationId, assessment.createdBy),
          questionId: row.id,
          pageNumber: region.page,
          bbox: [region.bbox.x1, region.bbox.y1, region.bbox.x2, region.bbox.y2],
        });
      }
    }
    for (const question of questions) {
      if (question.parentNumber && rowsByNumber.has(question.parentNumber)) {
        rowsByNumber.get(question.normalizedNumber)!.parentId = rowsByNumber.get(question.parentNumber)!.id;
      }
    }
    await this.session.flush();
  }

  private async storeAnswers(
    organizationId: string,
    assessment: Assessment,
    answers: ExtractedAnswer[]
  ): Promise<void> {
    const removedIds = await this.answers.clearForAssessment(organizationId, assessment.id);
    await this.answerRegions.clearForAnswers(organizationId, removedIds);
    await this.session.flush();

    for (const answer of answers) {
      const row: Answer = {
        ...newOrgOwned(organizationId, assessment.createdBy),
        assessmentId: assessment.id,
        externalId: answer.answerId,
        rawText: answer.rawText,
        normalizedText: answer.normalizedText,
        detectedLabel: answer.detectedLabel,
        confidence: answer.confidence,
        extractionMethod: answer.extractionMethod,
        isContinuationOf: answer.isContinuationOf,
      };
      this.answers.add(row);
      for (const region of answer.regions) {
        this.answerRegions.add({
          ...newOrgOwned(organizationId, assessment.createdBy),
          answerId: row.id,
          pageNumber: region.page,
          bbox: [region.bbox.x1, region.bbox.y1, region.bbox.x2, region.bbox.y2],
        });
      }
    }
    await this.session.flush();
  }

  private async storeMappings(organizationId: string, assessment: Assessment, mappings: Mapping[]): Promise<void> {
    await this.mappings.clearForAssessment(organizationId, assessment.id);
    const questionIds = new Map(
      (await this.questions.forAssessment(organizationId, assessment.id)).map((row) => [row.externalId, row.id])
    );
    const answerIds = new Map(
      (await this.answers.forAssessment(organizationId, assessment.id)).map((row) => [row.externalId, row.id])
    );
    for (const mapping of mappings) {
      const row: MappingRow = {
        ...newOrgOwned(organizationId, assessment.createdBy),
        assessmentId: assessment.id,
        questionId: mapping.questionId ? (questionIds.get(mapping.questionId) ?? null) : null,
        answerId: mapping.answerId ? (answerIds.get(mapping.answerId) ?? null) : null,
        mappingType: mapping.mappingType,
        confidence: mapping.confidence,
        reviewStatus: mapping.reviewStatus,
        evidence: mapping.evidence as unknown as Record<string, unknown>,
      };
      this.mappings.add(row);
    }
    await this.session.flush();
  }

  private async storeGrades(organizationId: string, assessment: Assessment, grades: Grade[]): Promise<void> {
    const mappingRows = await this.mappings.forAssessment(organizationId, assessment.id);
    const existing = await this.grades.forMappings(organizationId, mappingRows.map((row) => row.id));
    for (const row of existing) this.session.delete("grades", row.id);
    await this.session.flush();

    const questionIds = new Map(
      (await this.questions.forAssessment(organizationId, assessment.id)).map((row) => [row.externalId, row.id])
    );
    const byQuestion = new Map(mappingRows.filter((row) => row.questionId).map((row) => [row.questionId as string, row]));
    for (const grade of grades) {
      const questionDbId = questionIds.get(grade.questionId ?? "");
      const mappingRow = questionDbId ? byQuestion.get(questionDbId) : undefined;
      if (!mappingRow) continue;
      const row: GradeRow = {
        ...newOrgOwned(organizationId, assessment.createdBy),
        mappingId: mappingRow.id,
        score: grade.score,
        maxScore: grade.maxScore,
        rubric: { breakdown: grade.breakdown },
        feedback: grade.feedback,
        method: grade.method,
      };
      this.grades.add(row);
    }
    await this.session.flush();
  }

  // -------------------------------------------------------------------------- loads
  private async loadQuestions(organizationId: string, assessmentId: string): Promise<ExtractedQuestion[]> {
    const rows = await this.questions.forAssessment(organizationId, assessmentId);
    const regions = await this.questionRegions.forQuestions(organizationId, rows.map((r) => r.id));
    const byQuestion = new Map<string, Region[]>();
    for (const region of regions) {
      const list = byQuestion.get(region.questionId) ?? [];
      list.push({ page: region.pageNumber, bbox: { x1: region.bbox[0], y1: region.bbox[1], x2: region.bbox[2], y2: region.bbox[3] } });
      byQuestion.set(region.questionId, list);
    }
    const idToNumber = new Map(rows.map((r) => [r.id, r.normalizedNumber]));
    return rows.map((row) => {
      const rowRegions = (byQuestion.get(row.id) ?? []).sort((a, b) => a.page - b.page);
      return {
        questionId: row.externalId,
        displayNumber: row.displayNumber,
        normalizedNumber: row.normalizedNumber,
        parentNumber: row.parentId ? (idToNumber.get(row.parentId) ?? null) : null,
        text: row.text,
        pages: [...new Set(rowRegions.map((r) => r.page))].sort((a, b) => a - b),
        regions: rowRegions,
        orderIndex: row.orderIndex,
        optional: row.optional,
        maxMarks: row.maxMarks,
        confidence: row.confidence,
        blockIds: [],
      };
    });
  }

  private async loadAnswers(organizationId: string, assessmentId: string): Promise<ExtractedAnswer[]> {
    const rows = await this.answers.forAssessment(organizationId, assessmentId);
    const regions = await this.answerRegions.forAnswers(organizationId, rows.map((r) => r.id));
    const byAnswer = new Map<string, Region[]>();
    for (const region of regions) {
      const list = byAnswer.get(region.answerId) ?? [];
      list.push({ page: region.pageNumber, bbox: { x1: region.bbox[0], y1: region.bbox[1], x2: region.bbox[2], y2: region.bbox[3] } });
      byAnswer.set(region.answerId, list);
    }
    return rows.map((row) => {
      const rowRegions = (byAnswer.get(row.id) ?? []).sort((a, b) => a.page - b.page);
      return {
        answerId: row.externalId,
        rawText: row.rawText,
        normalizedText: row.normalizedText,
        detectedLabel: row.detectedLabel,
        detectedLabelDisplay: null,
        pageNumbers: [...new Set(rowRegions.map((r) => r.page))].sort((a, b) => a - b),
        regions: rowRegions,
        confidence: row.confidence,
        extractionMethod: row.extractionMethod as "text" | "ocr",
        isContinuationOf: row.isContinuationOf,
        blockIds: [],
      };
    });
  }

  async attachDocument(assessment: Assessment, kind: "question_paper" | "answer_sheet", documentId: string): Promise<void> {
    if (kind === "question_paper") assessment.questionDocId = documentId;
    else assessment.answerDocId = documentId;
    await this.session.flush();
  }
}

/** Writes the job failure in a brand-new transaction, independent of whatever the
 * failed attempt's (now rolled back) session was doing. */
async function recordJobFailure(organizationId: string, jobId: string, err: unknown): Promise<void> {
  await withSession(async (session) => {
    const jobs = new JobRepository(session);
    const job = await jobs.getOrThrow(organizationId, jobId);
    job.status = "failed";
    job.finishedAt = new Date();
    const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    job.error = `${code}: ${message}`;
  });
}
