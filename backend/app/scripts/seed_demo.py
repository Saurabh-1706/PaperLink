"""Seed a demo organization with one user per role, and (optionally) a processed
assessment built from the generated fixtures.

    python -m app.scripts.seed_demo [--with-assessment]
"""
from __future__ import annotations

import argparse

from app.core.permissions import Role
from app.db.models import Assessment
from app.db.repositories import AssessmentRepository
from app.db.session import create_all, session_scope
from app.modules.assessments.service import AssessmentService
from app.modules.auth.service import AuthService
from app.modules.documents.service import DocumentService
from app.schemas.common import DocumentKind
from app.storage.factory import get_storage

DEMO_PASSWORD = "Pass@123"
DEMO_USERS = [
    ("admin@gmail.com", Role.ADMIN),
    ("teacher@gmail.com", Role.TEACHER),
    ("reviewer@gmail.com", Role.REVIEWER),
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-assessment", action="store_true")
    args = parser.parse_args()

    create_all()
    with session_scope() as session:
        auth = AuthService(session)
        organization = auth.create_organization("Demo School")
        users = {
            email: auth.create_user(organization.id, email, DEMO_PASSWORD, role)
            for email, role in DEMO_USERS
        }
        teacher = users["teacher@gmail.com"]
        print(f"organization={organization.id}")
        for email in users:
            print(f"user={email} password={DEMO_PASSWORD}")

        if not args.with_assessment:
            return

        from tests.fixtures.generator import answer_sheet_pdf, question_paper_pdf

        storage = get_storage()
        assessment = Assessment(
            organization_id=organization.id,
            created_by=teacher.id,
            title="Demo Physics Assessment",
        )
        AssessmentRepository(session).add(assessment)

        documents = DocumentService(session, storage)
        service = AssessmentService(session, storage)
        for kind, data in (
            (DocumentKind.QUESTION_PAPER, question_paper_pdf()),
            (DocumentKind.ANSWER_SHEET, answer_sheet_pdf()),
        ):
            result = documents.ingest(
                organization_id=organization.id,
                assessment_id=assessment.id,
                kind=kind,
                data=data,
                created_by=teacher.id,
            )
            service.attach_document(assessment, kind, result.document.id)

        job = service.create_job(organization.id, assessment.id, teacher.id)
        service.process(organization.id, assessment.id, job.id)
        print(f"assessment={assessment.id} job={job.id}")


if __name__ == "__main__":
    main()
