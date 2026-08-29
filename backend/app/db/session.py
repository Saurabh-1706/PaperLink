"""MongoDB client, index setup, and the Unit of Work every repository runs inside.

The Unit of Work is deliberately small: an identity map plus a dirty check. Entities
are tracked when they are added or read, `flush()` writes back only the ones whose
document actually changed, and `commit()` ends the request. When Mongo is a replica
set (`MONGO_TRANSACTIONS=true`) the whole unit runs inside a real multi-document
transaction, so a stage that fails halfway leaves nothing behind; against a standalone
mongod there is no transaction to join, and `rollback()` can only drop writes that have
not been flushed yet. That difference is a property of the deployment, so it is
configuration rather than a code path chosen at import time.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from typing import Any

from pymongo import ASCENDING, MongoClient
from pymongo.database import Database

from app.core.config import settings
from app.core.logging import get_logger
from app.db.base import Entity

log = get_logger(__name__)

# (collection, keys, unique) - the uniqueness rules the data model promises, plus the
# org-scoped lookups every repository read performs.
INDEXES: list[tuple[str, list[tuple[str, int]], bool]] = [
    ("users", [("email", ASCENDING)], False),
    ("users", [("organization_id", ASCENDING), ("email", ASCENDING)], True),
    ("assessments", [("organization_id", ASCENDING)], False),
    ("documents", [("organization_id", ASCENDING), ("assessment_id", ASCENDING)], False),
    (
        "documents",
        [
            ("organization_id", ASCENDING),
            ("assessment_id", ASCENDING),
            ("kind", ASCENDING),
            ("checksum", ASCENDING),
        ],
        True,
    ),
    ("pages", [("organization_id", ASCENDING), ("document_id", ASCENDING)], False),
    ("pages", [("document_id", ASCENDING), ("page_number", ASCENDING)], True),
    ("blocks", [("organization_id", ASCENDING), ("page_id", ASCENDING)], False),
    ("questions", [("organization_id", ASCENDING), ("assessment_id", ASCENDING)], False),
    ("question_regions", [("organization_id", ASCENDING), ("question_id", ASCENDING)], False),
    ("answers", [("organization_id", ASCENDING), ("assessment_id", ASCENDING)], False),
    ("answer_regions", [("organization_id", ASCENDING), ("answer_id", ASCENDING)], False),
    (
        "mappings",
        [
            ("organization_id", ASCENDING),
            ("assessment_id", ASCENDING),
            ("review_status", ASCENDING),
        ],
        False,
    ),
    ("grades", [("organization_id", ASCENDING), ("mapping_id", ASCENDING)], False),
    ("jobs", [("organization_id", ASCENDING), ("assessment_id", ASCENDING)], False),
]


@lru_cache
def get_client() -> MongoClient:
    return MongoClient(settings.mongo_uri, uuidRepresentation="standard", tz_aware=True)


def get_database() -> Database:
    return get_client()[settings.mongo_db_name]


def create_all() -> None:
    """Mongo has no schema to migrate; indexes are the only thing to declare."""
    ensure_indexes(get_database())


def ensure_indexes(database: Database) -> None:
    for collection, keys, unique in INDEXES:
        database[collection].create_index(keys, unique=unique)


class UnitOfWork:
    """Identity map + dirty check over a MongoDB database."""

    def __init__(self, database: Database, *, use_transaction: bool | None = None) -> None:
        self.db = database
        self._use_transaction = (
            settings.mongo_transactions if use_transaction is None else use_transaction
        )
        self._client_session: Any | None = None
        self._identity: dict[tuple[str, str], Entity] = {}
        self._snapshots: dict[tuple[str, str], dict[str, Any]] = {}
        self._deleted: dict[tuple[str, str], Entity] = {}

    # ------------------------------------------------------------------- transactions
    @property
    def client_session(self) -> Any | None:
        """The pymongo session to pass to every driver call, or None when transactions
        are off. Repositories pass it so their reads see this unit own writes."""
        if not self._use_transaction:
            return None
        if self._client_session is None:
            self._client_session = self.db.client.start_session()
            self._client_session.start_transaction()
        return self._client_session

    # ------------------------------------------------------------------- identity map
    @staticmethod
    def _key(entity: Entity) -> tuple[str, str]:
        return (type(entity).__collection__, entity.id)

    def track(self, entity: Entity) -> Entity:
        """Register an entity read from Mongo, returning the instance already in the
        map if there is one - two reads of the same row must not diverge in memory."""
        key = self._key(entity)
        if key in self._identity:
            return self._identity[key]
        self._identity[key] = entity
        self._snapshots[key] = entity.to_mongo()
        return entity

    def tracked(self, collection: str, entity_id: str) -> Entity | None:
        return self._identity.get((collection, entity_id))

    # -------------------------------------------------------------------------- writes
    def add(self, entity: Entity) -> Entity:
        if not type(entity).__collection__:
            raise AssertionError(f"{type(entity).__name__} declares no __collection__")
        key = self._key(entity)
        self._identity[key] = entity
        self._snapshots.pop(key, None)  # no snapshot -> treated as an insert on flush
        self._deleted.pop(key, None)
        return entity

    def delete(self, entity: Entity) -> None:
        key = self._key(entity)
        self._identity.pop(key, None)
        self._snapshots.pop(key, None)
        self._deleted[key] = entity

    def flush(self) -> None:
        """Write pending deletes and every entity whose document changed."""
        for (collection, entity_id), _entity in list(self._deleted.items()):
            self.db[collection].delete_one({"_id": entity_id}, session=self.client_session)
        self._deleted.clear()

        for key, entity in list(self._identity.items()):
            collection, entity_id = key
            document = entity.to_mongo()
            snapshot = self._snapshots.get(key)
            if snapshot == document:
                continue
            if snapshot is not None:
                entity.touch()
                document = entity.to_mongo()
            self.db[collection].replace_one(
                {"_id": entity_id}, document, upsert=True, session=self.client_session
            )
            self._snapshots[key] = document

    def commit(self) -> None:
        self.flush()
        if self._client_session is not None:
            self._client_session.commit_transaction()
            self._client_session.end_session()
            self._client_session = None

    def rollback(self) -> None:
        if self._client_session is not None:
            self._client_session.abort_transaction()
            self._client_session.end_session()
            self._client_session = None
        else:
            log.warning("rollback without a transaction: only unflushed writes are discarded")
        self.expire_all()

    def expire_all(self) -> None:
        """Forget every in-memory entity so the next read comes from Mongo."""
        self._identity.clear()
        self._snapshots.clear()
        self._deleted.clear()

    def close(self) -> None:
        if self._client_session is not None:
            self._client_session.abort_transaction()
            self._client_session.end_session()
            self._client_session = None
        self.expire_all()


@contextmanager
def session_scope() -> Iterator[UnitOfWork]:
    unit = UnitOfWork(get_database())
    try:
        yield unit
        unit.commit()
    except Exception:
        unit.rollback()
        raise
    finally:
        unit.close()


def get_session() -> Iterator[UnitOfWork]:
    """FastAPI dependency."""
    unit = UnitOfWork(get_database())
    try:
        yield unit
    finally:
        unit.close()
