"""Assessment processing: connects the three graphs to persistence.

Stage order is fixed and each stage reports progress into `jobs`, so a slow OCR pass is
observable rather than opaque.
"""
from __future__ import annotations

from datetime import UTC, datetime

from app.ai.llm.factory import get_llm_provider, get_vision_provider
from app.core.errors import AppError, NotFoundError
from app.core.logging import assessment_id_var, get_logger
from app.db.models import (
    Answer,
    AnswerRegion,
    Assessment,
    GradeRow,
    Job,
    MappingRow,
    Question,
    QuestionRegion,
)
from app.db.repositories import (
    AnswerRegionRepository,
    AnswerRepository,
    AssessmentRepository,
    DocumentRepository,
    GradeRepository,
    JobRepository,
    MappingRepository,
    QuestionRegionRepository,
    QuestionRepository,
)
from app.db.session import UnitOfWork
from app.graphs.answer_graph import run_answer_graph
from app.graphs.mapping_graph import run_mapping_graph
from app.graphs.question_graph import run_question_graph
from app.modules.answer_pipeline.pipeline import merge_continuations
from app.modules.documents.service import DocumentService
from app.modules.grading.engine import grade_assessment
from app.schemas.common import DocumentKind, JobStage, JobStatus, MappingType, Region
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion
from app.storage.base import StorageBackend

log = get_logger(__name__)


class AssessmentService:
    def __init__(self, session: UnitOfWork, storage: StorageBackend) -> None:
        self.session = session
        self.storage = storage
        self.assessments = AssessmentRepository(session)
        self.documents = DocumentRepository(session)
        self.questions = QuestionRepository(session)
        self.question_regions = QuestionRegionRepository(session)
        self.answers = AnswerRepository(session)
        self.answer_regions = AnswerRegionRepository(session)
        self.mappings = MappingRepository(session)
        self.grades = GradeRepository(session)
        self.jobs = JobRepository(session)
        self.document_service = DocumentService(session, storage)

    # ---------------------------------------------------------------------------- jobs
    def create_job(self, organization_id: str, assessment_id: str, created_by: str | None) -> Job:
        job = Job(
            organization_id=organization_id,
            created_by=created_by,
            assessment_id=assessment_id,
            stage=str(JobStage.INGESTION),
            status=str(JobStatus.QUEUED),
        )
        self.jobs.add(job)
        return job

    def _advance(self, job: Job, stage: JobStage, progress: float) -> None:
        job.stage = str(stage)
        job.status = str(JobStatus.RUNNING)
        job.progress = progress
        if job.started_at is None:
            job.started_at = datetime.now(UTC)
        self.session.flush()

    def _fail(self, job: Job, error: AppError | Exception) -> None:
        job.status = str(JobStatus.FAILED)
        job.finished_at = datetime.now(UTC)
        code = error.code if isinstance(error, AppError) else "INTERNAL_ERROR"
        job.error = f"{code}: {error}"
        self.session.flush()

    # ---------------------------------------------------------------------- processing
    def process(
        self, organization_id: str, assessment_id: str, job_id: str, remap_only: bool = False
    ) -> bool:
        """Run the pipeline. Returns True on success; a failure is recorded on the job
        (typed code + message) and committed rather than raised, so the client can poll
        for it instead of losing it to a rollback."""
        assessment_id_var.set(assessment_id)
        job = self.jobs.get_or_404(organization_id, job_id)
        assessment = self.assessments.get_or_404(organization_id, assessment_id)
        try:
            if remap_only:
                self._run_mapping_and_grading(organization_id, assessment, job)
            else:
                self._run_full(organization_id, assessment, job)
            job.status = str(JobStatus.SUCCEEDED)
            job.stage = str(JobStage.DONE)
            job.progress = 1.0
            job.finished_at = datetime.now(UTC)
            assessment.status = "processed"
            self.session.flush()
            return True
        except Exception as exc:  # noqa: BLE001 - a failed stage writes a typed error, never an empty result
            log.exception("processing failed", extra={"assessment_id": assessment_id})
            self.session.rollback()
            job = self.jobs.get_or_404(organization_id, job_id)
            self._fail(job, exc)
            return False

    def _run_full(self, organization_id: str, assessment: Assessment, job: Job) -> None:
        if not assessment.question_doc_id or not assessment.answer_doc_id:
            raise NotFoundError("Both a question paper and an answer sheet are required.")

        self._advance(job, JobStage.QUESTION_EXTRACTION, 0.2)
        question_doc = self.documents.get_or_404(organization_id, assessment.question_doc_id)
        question_ir = self.document_service.load_ir(question_doc)
        question_result = run_question_graph(question_ir, provider=_vision_provider())
        self._store_questions(organization_id, assessment, question_result.questions)

        self._advance(job, JobStage.ANSWER_EXTRACTION, 0.5)
        answer_doc = self.documents.get_or_404(organization_id, assessment.answer_doc_id)
        answer_ir = self.document_service.load_ir(answer_doc)
        page_images = self.document_service.page_images(organization_id, answer_doc)
        answer_result = run_answer_graph(answer_ir, provider=_vision_provider(), page_images=page_images)
        self._store_answers(organization_id, assessment, answer_result.answers)

        self._run_mapping_and_grading(organization_id, assessment, job)

    def _run_mapping_and_grading(self, organization_id: str, assessment: Assessment, job: Job) -> None:
        self._advance(job, JobStage.MAPPING, 0.75)
        questions = self._load_questions(organization_id, assessment.id)
        answers = self._load_answers(organization_id, assessment.id)
        mapping_result = run_mapping_graph(questions, answers, provider=_llm_provider())
        self._store_mappings(organization_id, assessment, mapping_result.mappings)

        self._advance(job, JobStage.GRADING, 0.9)
        grades = grade_assessment(
            mapping_result.mappings,
            {question.question_id: question for question in questions},
            {answer.answer_id: answer for answer in merge_continuations(answers)},
            llm=_llm_provider(),
        )
        self._store_grades(organization_id, assessment, grades)

    # ------------------------------------------------------------------------ storage
    def _store_questions(
        self, organization_id: str, assessment: Assessment, questions: list[ExtractedQuestion]
    ) -> None:
        for row in self.questions.for_assessment(organization_id, assessment.id):
            self.session.delete(row)
        self.session.flush()

        rows: dict[str, Question] = {}
        for question in questions:
            row = Question(
                organization_id=organization_id,
                created_by=assessment.created_by,
                assessment_id=assessment.id,
                external_id=question.question_id,
                display_number=question.display_number,
                normalized_number=question.normalized_number,
                text=question.text,
                order_index=question.order_index,
                optional=question.optional,
                max_marks=question.max_marks,
                confidence=question.confidence,
            )
            self.questions.add(row)
            rows[question.normalized_number] = row
            for region in question.regions:
                self.question_regions.add(
                    QuestionRegion(
                        organization_id=organization_id,
                        question_id=row.id,
                        page_number=region.page,
                        bbox=region.bbox.as_list(),
                    )
                )
        for question in questions:
            if question.parent_number and question.parent_number in rows:
                rows[question.normalized_number].parent_id = rows[question.parent_number].id
        self.session.flush()

    def _store_answers(
        self, organization_id: str, assessment: Assessment, answers: list[ExtractedAnswer]
    ) -> None:
        for row in self.answers.for_assessment(organization_id, assessment.id):
            self.session.delete(row)
        self.session.flush()

        for answer in answers:
            row = Answer(
                organization_id=organization_id,
                created_by=assessment.created_by,
                assessment_id=assessment.id,
                external_id=answer.answer_id,
                raw_text=answer.raw_text,
                normalized_text=answer.normalized_text,
                detected_label=answer.detected_label,
                confidence=answer.confidence,
                extraction_method=str(answer.extraction_method),
                is_continuation_of=answer.is_continuation_of,
            )
            self.answers.add(row)
            for region in answer.regions:
                self.answer_regions.add(
                    AnswerRegion(
                        organization_id=organization_id,
                        answer_id=row.id,
                        page_number=region.page,
                        bbox=region.bbox.as_list(),
                    )
                )
        self.session.flush()

    def _store_mappings(self, organization_id: str, assessment: Assessment, mappings) -> None:
        self.mappings.clear_for_assessment(organization_id, assessment.id)
        question_ids = {
            row.external_id: row.id for row in self.questions.for_assessment(organization_id, assessment.id)
        }
        answer_ids = {
            row.external_id: row.id for row in self.answers.for_assessment(organization_id, assessment.id)
        }
        for mapping in mappings:
            self.mappings.add(
                MappingRow(
                    organization_id=organization_id,
                    created_by=assessment.created_by,
                    assessment_id=assessment.id,
                    question_id=question_ids.get(mapping.question_id or ""),
                    answer_id=answer_ids.get(mapping.answer_id or ""),
                    mapping_type=str(mapping.mapping_type),
                    confidence=mapping.confidence,
                    review_status=str(mapping.review_status),
                    evidence=mapping.evidence.model_dump(),
                )
            )
        self.session.flush()

    def _store_grades(self, organization_id: str, assessment: Assessment, grades) -> None:
        rows = self.mappings.for_assessment(organization_id, assessment.id)
        existing = self.grades.for_mappings(organization_id, [row.id for row in rows])
        for row in existing:
            self.session.delete(row)
        self.session.flush()

        question_ids = {
            row.external_id: row.id for row in self.questions.for_assessment(organization_id, assessment.id)
        }
        by_question = {row.question_id: row for row in rows if row.question_id}
        for grade in grades:
            mapping_row = by_question.get(question_ids.get(grade.question_id or "", ""))
            if mapping_row is None:
                continue
            self.grades.add(
                GradeRow(
                    organization_id=organization_id,
                    created_by=assessment.created_by,
                    mapping_id=mapping_row.id,
                    score=grade.score,
                    max_score=grade.max_score,
                    rubric={"breakdown": [item.model_dump() for item in grade.breakdown]},
                    feedback=grade.feedback,
                    method=grade.method,
                )
            )
        self.session.flush()

    # -------------------------------------------------------------------------- loads
    def _load_questions(self, organization_id: str, assessment_id: str) -> list[ExtractedQuestion]:
        rows = self.questions.for_assessment(organization_id, assessment_id)
        regions = self.question_regions.for_questions(organization_id, [row.id for row in rows])
        by_question: dict[str, list[Region]] = {}
        for region in regions:
            by_question.setdefault(region.question_id, []).append(
                Region(page=region.page_number, bbox=region.bbox)
            )
        id_to_number = {row.id: row.normalized_number for row in rows}
        return [
            ExtractedQuestion(
                question_id=row.external_id,
                display_number=row.display_number,
                normalized_number=row.normalized_number,
                parent_number=id_to_number.get(row.parent_id or ""),
                text=row.text,
                pages=sorted({region.page for region in by_question.get(row.id, [])}),
                regions=sorted(by_question.get(row.id, []), key=lambda r: r.page),
                order_index=row.order_index,
                optional=row.optional,
                max_marks=row.max_marks,
                confidence=row.confidence,
            )
            for row in rows
        ]

    def _load_answers(self, organization_id: str, assessment_id: str) -> list[ExtractedAnswer]:
        rows = self.answers.for_assessment(organization_id, assessment_id)
        regions = self.answer_regions.for_answers(organization_id, [row.id for row in rows])
        by_answer: dict[str, list[Region]] = {}
        for region in regions:
            by_answer.setdefault(region.answer_id, []).append(
                Region(page=region.page_number, bbox=region.bbox)
            )
        return [
            ExtractedAnswer(
                answer_id=row.external_id,
                raw_text=row.raw_text,
                normalized_text=row.normalized_text,
                detected_label=row.detected_label,
                page_numbers=sorted({region.page for region in by_answer.get(row.id, [])}),
                regions=sorted(by_answer.get(row.id, []), key=lambda r: r.page),
                confidence=row.confidence,
                extraction_method=row.extraction_method,
                is_continuation_of=row.is_continuation_of,
            )
            for row in rows
        ]

    # ------------------------------------------------------------------------ results
    def results(self, organization_id: str, assessment_id: str) -> dict:
        rows = self.mappings.for_assessment(organization_id, assessment_id)
        grades = {
            grade.mapping_id: grade
            for grade in self.grades.for_mappings(organization_id, [row.id for row in rows])
        }
        total = sum(grade.score for grade in grades.values())
        possible = sum(grade.max_score for grade in grades.values())
        return {
            "assessment_id": assessment_id,
            "mapping_count": len(rows),
            "needs_review": sum(1 for row in rows if row.review_status == "needs_review"),
            "unanswered": sum(1 for row in rows if row.mapping_type == str(MappingType.UNANSWERED)),
            "unmatched": sum(1 for row in rows if row.mapping_type == str(MappingType.UNMATCHED)),
            "total_score": round(total, 2),
            "max_score": round(possible, 2),
            "percentage": round(100 * total / possible, 2) if possible else 0.0,
        }

    def attach_document(self, assessment: Assessment, kind: DocumentKind, document_id: str) -> None:
        if kind == DocumentKind.QUESTION_PAPER:
            assessment.question_doc_id = document_id
        else:
            assessment.answer_doc_id = document_id
        self.session.flush()


def _llm_provider():
    provider = get_llm_provider()
    return None if provider.name == "null" else provider


def _vision_provider():
    provider = get_vision_provider()
    return None if provider.name == "null" else provider
