"""Storage interface. Business logic imports this ABC, never a vendor module."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from app.core.errors import NotFoundError


class StorageBackend(ABC):
    @abstractmethod
    def put(self, key: str, data: bytes, metadata: dict[str, Any] | None = None) -> str:
        """Store bytes and return a storage URI.

        `metadata` is advisory (tenant/assessment/document ids): backends that can hold
        it should, so a stored object can be traced back to its owner without a join.
        """

    @abstractmethod
    def get(self, uri: str, *, organization_id: str | None = None) -> bytes: ...

    @abstractmethod
    def exists(self, uri: str) -> bool: ...

    @abstractmethod
    def delete(self, uri: str) -> None: ...

    # ------------------------------------------------------------------------ helpers
    @staticmethod
    def assert_tenant(key: str, organization_id: str | None) -> None:
        """Every key is written under `<organization_id>/...`. Callers that know which
        tenant is asking pass it, and a mismatch reads as absent - never as forbidden,
        which would confirm the object exists (docs/05-rbac.md)."""
        if organization_id and key.split("/", 1)[0] != organization_id:
            raise NotFoundError("Stored object not found.", key=key)
