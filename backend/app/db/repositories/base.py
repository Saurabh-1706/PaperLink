"""Org-scoped repository base.

`organization_id` is a required argument on every method, and the base asserts in code
that the filter carries it before the query reaches Mongo. Convention alone is not
enough - the assert is what survives a careless query added later (docs/05-rbac.md).
"""
from __future__ import annotations

from typing import Any, Generic, TypeVar

from app.core.errors import NotFoundError
from app.db.base import Entity
from app.db.session import UnitOfWork

ModelT = TypeVar("ModelT", bound=Entity)


class OrgScopedRepository(Generic[ModelT]):
    model: type[Any]

    def __init__(self, session: UnitOfWork) -> None:
        self.session = session

    # ------------------------------------------------------------------ query building
    @property
    def collection(self):
        return self.session.db[self.model.__collection__]

    def _scoped(self, organization_id: str, **filters: Any) -> dict[str, Any]:
        if not organization_id:
            raise AssertionError("organization_id is required on every repository query")
        query: dict[str, Any] = {"organization_id": organization_id}
        for field, value in filters.items():
            if value is not None:
                query[field] = value
        self._assert_org_filter(query)
        return query

    @staticmethod
    def _assert_org_filter(query: dict[str, Any]) -> None:
        if not query.get("organization_id"):
            raise AssertionError("query is missing its organization scope")

    # ------------------------------------------------------------------------- reads
    def _hydrate(self, document: dict[str, Any] | None) -> ModelT | None:
        if document is None:
            return None
        return self.session.track(self.model.from_mongo(document))  # type: ignore[return-value]

    def _hydrate_all(self, documents) -> list[ModelT]:
        return [self._hydrate(document) for document in documents]  # type: ignore[misc]

    def find_one(self, query: dict[str, Any]) -> ModelT | None:
        self._assert_org_filter(query)
        return self._hydrate(self.collection.find_one(query, session=self.session.client_session))

    def find(self, query: dict[str, Any], sort: list[tuple[str, int]] | None = None) -> list[ModelT]:
        self._assert_org_filter(query)
        cursor = self.collection.find(query, session=self.session.client_session)
        if sort:
            cursor = cursor.sort(sort)
        return self._hydrate_all(cursor)

    def get(self, organization_id: str, entity_id: str) -> ModelT | None:
        return self.find_one(self._scoped(organization_id, _id=entity_id))

    def get_or_404(self, organization_id: str, entity_id: str) -> ModelT:
        entity = self.get(organization_id, entity_id)
        if entity is None:
            # 404, not 403 - a 403 would confirm the resource exists in another org.
            raise NotFoundError(details_id=entity_id)
        return entity

    def list(self, organization_id: str, **filters: Any) -> list[ModelT]:
        return self.find(self._scoped(organization_id, **filters))

    # ------------------------------------------------------------------------ writes
    def add(self, entity: ModelT) -> ModelT:
        if not getattr(entity, "organization_id", None):
            raise AssertionError("cannot persist an entity without organization_id")
        self.session.add(entity)
        self.session.flush()
        return entity

    def delete(self, organization_id: str, entity_id: str) -> None:
        entity = self.get_or_404(organization_id, entity_id)
        self.session.delete(entity)
        self.session.flush()
