"""GridFS storage backend.

Originals (PDFs), rendered page images, IR-JSON and rendered markdown all live in
GridFS inside the same MongoDB database as the metadata, so a document and its bytes
are backed up, restored and dropped together. Keys keep the tenant-first layout
`<organization_id>/<assessment_id>/<document_id>/...`, and the tenant ids are also
written into the file metadata so an object can be traced without reading a key.
"""
from __future__ import annotations

from typing import Any

from app.core.errors import NotFoundError
from app.storage.base import StorageBackend

SCHEME = "gridfs://"


class GridFSStorage(StorageBackend):
    def __init__(self, database, bucket: str = "documents") -> None:
        import gridfs

        self.bucket_name = bucket
        self.fs = gridfs.GridFS(database, collection=bucket)

    @staticmethod
    def _key(key_or_uri: str) -> str:
        return key_or_uri[len(SCHEME) :] if key_or_uri.startswith(SCHEME) else key_or_uri

    def put(self, key: str, data: bytes, metadata: dict[str, Any] | None = None) -> str:
        key = self._key(key)
        meta = dict(metadata or {})
        meta.setdefault("organization_id", key.split("/", 1)[0])
        # Re-ingesting the same key replaces it: GridFS versions files by default, and
        # unbounded versions of a 40-page scan is a storage leak, not a feature.
        for existing in self.fs.find({"filename": key}):
            self.fs.delete(existing._id)
        self.fs.put(data, filename=key, metadata=meta)
        return f"{SCHEME}{key}"

    def get(self, uri: str, *, organization_id: str | None = None) -> bytes:
        key = self._key(uri)
        self.assert_tenant(key, organization_id)
        stored = self.fs.find_one({"filename": key})
        if stored is None:
            raise NotFoundError("Stored object not found.", uri=uri)
        return stored.read()

    def exists(self, uri: str) -> bool:
        return self.fs.exists({"filename": self._key(uri)})

    def delete(self, uri: str) -> None:
        for existing in self.fs.find({"filename": self._key(uri)}):
            self.fs.delete(existing._id)
