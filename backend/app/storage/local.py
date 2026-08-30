"""Filesystem storage backend.

Kept for local development and for tests that want to inspect artifacts on disk; the
deployed system stores binaries in GridFS (`app/storage/gridfs.py`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.errors import NotFoundError
from app.storage.base import StorageBackend

SCHEME = "local://"


class LocalStorage(StorageBackend):
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _key(key_or_uri: str) -> str:
        return key_or_uri[len(SCHEME) :] if key_or_uri.startswith(SCHEME) else key_or_uri

    def _path(self, key_or_uri: str) -> Path:
        key = self._key(key_or_uri)
        path = (self.root / key).resolve()
        if not str(path).startswith(str(self.root)):
            raise NotFoundError("Storage key escapes the storage root.", key=key)
        return path

    def put(self, key: str, data: bytes, metadata: dict[str, Any] | None = None) -> str:
        # The filesystem has nowhere to put metadata; the key already carries the tenant.
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return f"{SCHEME}{key}"

    def get(self, uri: str, *, organization_id: str | None = None) -> bytes:
        self.assert_tenant(self._key(uri), organization_id)
        path = self._path(uri)
        if not path.is_file():
            raise NotFoundError("Stored object not found.", uri=uri)
        return path.read_bytes()

    def exists(self, uri: str) -> bool:
        return self._path(uri).is_file()

    def delete(self, uri: str) -> None:
        path = self._path(uri)
        if path.is_file():
            path.unlink()
