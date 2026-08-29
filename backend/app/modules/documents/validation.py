"""Upload validation. Never trust the declared content type (docs/pipelines/extraction.md)."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from app.core.config import settings
from app.core.errors import (
    CorruptDocumentError,
    EncryptedPdfError,
    FileTooLargeError,
    TooManyPagesError,
    UnsupportedFileError,
)

PDF_MAGIC = b"%PDF-"


@dataclass(frozen=True)
class ValidatedUpload:
    checksum: str
    size: int
    page_count: int
    mime: str = "application/pdf"


def compute_checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_pdf(data: bytes, declared_mime: str | None = None) -> ValidatedUpload:
    if not data:
        raise UnsupportedFileError("The uploaded file is empty.")
    if len(data) > settings.max_upload_bytes:
        raise FileTooLargeError(size=len(data), cap=settings.max_upload_bytes)
    if not data.startswith(PDF_MAGIC):
        raise UnsupportedFileError(
            "The uploaded file is not a PDF.", declared_mime=declared_mime
        )

    import pymupdf

    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - any open failure is a corrupt document
        raise CorruptDocumentError(str(exc)) from exc

    try:
        if document.needs_pass:
            raise EncryptedPdfError()
        page_count = document.page_count
        if page_count == 0:
            raise CorruptDocumentError("The PDF contains no pages.")
        if page_count > settings.max_pages:
            raise TooManyPagesError(page_count=page_count, cap=settings.max_pages)
    finally:
        document.close()

    return ValidatedUpload(
        checksum=compute_checksum(data), size=len(data), page_count=page_count
    )
