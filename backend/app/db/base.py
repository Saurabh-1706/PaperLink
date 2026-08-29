"""Document base classes and shared field mixins.

Entities are plain dataclasses, not ORM rows: MongoDB stores them whole. The Unit of
Work (`app.db.session`) is what tracks them, assigns `_id` and writes changes — an
entity never talks to the driver itself.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import UTC, datetime
from typing import Any, ClassVar, TypeVar


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(UTC)


EntityT = TypeVar("EntityT", bound="Entity")


@dataclass
class Entity:
    """Base for every persisted document.

    `id` is a hex uuid stored as `_id`: readable in logs, stable across export/import,
    and free of the ObjectId-vs-string coercion bugs that come from mixing the two.
    """

    __collection__: ClassVar[str] = ""

    id: str = field(default_factory=new_id)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    # ------------------------------------------------------------------ serialisation
    def to_mongo(self) -> dict[str, Any]:
        document = asdict(self)
        document["_id"] = document.pop("id")
        return document

    @classmethod
    def from_mongo(cls: type[EntityT], document: dict[str, Any]) -> EntityT:
        data = dict(document)
        data["id"] = data.pop("_id")
        known = {f.name for f in fields(cls)}
        # Unknown keys are ignored rather than fatal: a schemaless store will outlive
        # any single version of this code, and a stale field must not break a read.
        return cls(**{key: value for key, value in data.items() if key in known})

    def touch(self) -> None:
        self.updated_at = utcnow()


@dataclass
class OrgOwned(Entity):
    """Every tenant-owned document carries organization_id and created_by."""

    organization_id: str = ""
    created_by: str | None = None
