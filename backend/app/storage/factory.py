"""Storage selection is config, never an import (ADR-004)."""
from __future__ import annotations

from functools import lru_cache

from app.core.config import settings
from app.storage.base import StorageBackend


@lru_cache
def get_storage() -> StorageBackend:
    if settings.storage_backend == "gridfs":
        from app.db.session import get_database
        from app.storage.gridfs import GridFSStorage

        return GridFSStorage(get_database(), settings.gridfs_bucket)
    if settings.storage_backend == "local":
        from app.storage.local import LocalStorage

        return LocalStorage(settings.storage_path)
    raise NotImplementedError(f"storage backend '{settings.storage_backend}' is not built yet")
