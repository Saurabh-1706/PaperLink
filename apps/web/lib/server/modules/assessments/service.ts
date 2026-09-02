/**
 * Assessment CRUD. Port of the non-pipeline parts of
 * backend/app/modules/assessments/service.py — `process`/`remap` and everything
 * downstream of them (question/answer pipelines, mapping, grading) are Phase 2+
 * (see the migration plan); this only covers what Phase 1's routes need.
 */
import type { UnitOfWork } from "@/lib/server/db/session";
import { newOrgOwned } from "@/lib/server/db/base";
import { AssessmentRepository } from "@/lib/server/db/repositories";
import type { Assessment } from "@/lib/server/db/models";

export class AssessmentService {
  private assessments: AssessmentRepository;

  constructor(private session: UnitOfWork) {
    this.assessments = new AssessmentRepository(session);
  }

  async create(organizationId: string, createdBy: string, title: string): Promise<Assessment> {
    const assessment: Assessment = {
      ...newOrgOwned(organizationId, createdBy),
      title,
      status: "created",
      questionDocId: null,
      answerDocId: null,
    };
    this.assessments.add(assessment);
    await this.session.flush();
    return assessment;
  }

  get(organizationId: string, assessmentId: string): Promise<Assessment> {
    return this.assessments.getOrThrow(organizationId, assessmentId);
  }

  async attachDocument(
    assessment: Assessment,
    kind: "question_paper" | "answer_sheet",
    documentId: string
  ): Promise<void> {
    if (kind === "question_paper") assessment.questionDocId = documentId;
    else assessment.answerDocId = documentId;
    await this.session.flush();
  }
}
