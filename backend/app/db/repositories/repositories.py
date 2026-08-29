"""Concrete repositories. Every read path goes through the org-scoped base."""
from __future__ import annotations

from pymongo import ASCENDING

from app.db.models import (
    Answer,
    AnswerRegion,
    Assessment,
    Block,
    Document,
    GradeRow,
    Job,
    MappingRow,
    Page,
    Question,
    QuestionRegion,
    User,
)
from app.db.repositories.base import OrgScopedRepository


class UserRepository(OrgScopedRepository[User]):
    model = User

    def by_email(self, email: str) -> User | None:
        """Login is the one lookup that cannot be org-scoped: the caller has no token
        yet. It is deliberately confined to this method and matches on email only."""
        document = self.collection.find_one(
            {"email": email.lower(), "is_active": True}, session=self.session.client_session
        )
        return self._hydrate(document)


class AssessmentRepository(OrgScopedRepository[Assessment]):
    model = Assessment


class DocumentRepository(OrgScopedRepository[Document]):
    model = Document

    def by_checksum(
        self, organization_id: str, assessment_id: str, kind: str, checksum: str
    ) -> Document | None:
        return self.find_one(
            self._scoped(
                organization_id, assessment_id=assessment_id, kind=kind, checksum=checksum
            )
        )


class PageRepository(OrgScopedRepository[Page]):
    model = Page

    def by_number(self, organization_id: str, document_id: str, page_number: int) -> Page | None:
        return self.find_one(
            self._scoped(organization_id, document_id=document_id, page_number=page_number)
        )

    def for_document(self, organization_id: str, document_id: str) -> list[Page]:
        return self.find(
            self._scoped(organization_id, document_id=document_id),
            sort=[("page_number", ASCENDING)],
        )


class BlockRepository(OrgScopedRepository[Block]):
    model = Block

    def for_page(self, organization_id: str, page_id: str) -> list[Block]:
        return self.find(
            self._scoped(organization_id, page_id=page_id), sort=[("reading_order", ASCENDING)]
        )


class QuestionRepository(OrgScopedRepository[Question]):
    model = Question

    def for_assessment(self, organization_id: str, assessment_id: str) -> list[Question]:
        return self.find(
            self._scoped(organization_id, assessment_id=assessment_id),
            sort=[("order_index", ASCENDING)],
        )


class QuestionRegionRepository(OrgScopedRepository[QuestionRegion]):
    model = QuestionRegion

    def for_questions(self, organization_id: str, question_ids: list[str]) -> list[QuestionRegion]:
        if not question_ids:
            return []
        query = self._scoped(organization_id)
        query["question_id"] = {"$in": question_ids}
        return self.find(query)


class AnswerRepository(OrgScopedRepository[Answer]):
    model = Answer

    def for_assessment(self, organization_id: str, assessment_id: str) -> list[Answer]:
        return self.find(self._scoped(organization_id, assessment_id=assessment_id))


class AnswerRegionRepository(OrgScopedRepository[AnswerRegion]):
    model = AnswerRegion

    def for_answers(self, organization_id: str, answer_ids: list[str]) -> list[AnswerRegion]:
        if not answer_ids:
            return []
        query = self._scoped(organization_id)
        query["answer_id"] = {"$in": answer_ids}
        return self.find(query)


class MappingRepository(OrgScopedRepository[MappingRow]):
    model = MappingRow

    def for_assessment(
        self, organization_id: str, assessment_id: str, review_status: str | None = None
    ) -> list[MappingRow]:
        return self.find(
            self._scoped(
                organization_id, assessment_id=assessment_id, review_status=review_status
            )
        )

    def clear_for_assessment(self, organization_id: str, assessment_id: str) -> None:
        for row in self.for_assessment(organization_id, assessment_id):
            self.session.delete(row)
        self.session.flush()


class GradeRepository(OrgScopedRepository[GradeRow]):
    model = GradeRow

    def for_mappings(self, organization_id: str, mapping_ids: list[str]) -> list[GradeRow]:
        if not mapping_ids:
            return []
        query = self._scoped(organization_id)
        query["mapping_id"] = {"$in": mapping_ids}
        return self.find(query)


class JobRepository(OrgScopedRepository[Job]):
    model = Job

    def for_assessment(self, organization_id: str, assessment_id: str) -> list[Job]:
        return self.find(self._scoped(organization_id, assessment_id=assessment_id))
