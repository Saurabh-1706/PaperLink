"""Organizations, users, assessments and jobs."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar

from app.db.base import Entity, OrgOwned


@dataclass
class Organization(Entity):
    __collection__: ClassVar[str] = "organizations"

    name: str = ""


@dataclass
class User(OrgOwned):
    __collection__: ClassVar[str] = "users"

    email: str = ""
    hashed_password: str = ""
    role: str = ""
    is_active: bool = True


@dataclass
class Assessment(OrgOwned):
    __collection__: ClassVar[str] = "assessments"

    title: str = ""
    status: str = "created"
    question_doc_id: str | None = None
    answer_doc_id: str | None = None


@dataclass
class Job(OrgOwned):
    __collection__: ClassVar[str] = "jobs"

    assessment_id: str = ""
    stage: str = "ingestion"
    status: str = "queued"
    progress: float = 0.0
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
