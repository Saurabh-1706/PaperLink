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
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class ValidatedUpload:
    checksum: str
    size: int
    page_count: int
    mime: str = "application/pdf"


def compute_checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _looks_like_image(data: bytes) -> bool:
    return data.startswith(JPEG_MAGIC) or data.startswith(PNG_MAGIC)


def normalize_upload_to_pdf(uploads: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    """Accept exactly what `validate_pdf` always has (one PDF), or one-or-more JPEG/PNG
    images -- one per page, in the given order -- and return `(pdf_bytes, mime)` ready
    for it. A photographed answer sheet is normally several separate photos rather
    than one PDF; this lets the upload endpoint accept that directly, with no change
    to validation, storage, or extraction, none of which ever see anything but a
    single PDF blob either way.

    A mixed batch (a PDF alongside images, or anything that isn't a PDF/JPEG/PNG) is
    rejected outright rather than guessed at.
    """
    if not uploads:
        raise UnsupportedFileError("No file was uploaded.")
    if len(uploads) == 1 and uploads[0][1].startswith(PDF_MAGIC):
        return uploads[0][1], "application/pdf"

    images: list[bytes] = []
    for filename, data in uploads:
        if not _looks_like_image(data):
            raise UnsupportedFileError(
                "Upload a single PDF, or one or more JPEG/PNG images (one per page).",
                filename=filename,
            )
        images.append(data)

    from app.modules.documents.pdf import images_to_pdf

    try:
        pdf_bytes = images_to_pdf(images)
    except Exception as exc:  # noqa: BLE001 - any decode failure is a corrupt upload
        raise CorruptDocumentError(str(exc)) from exc
    return pdf_bytes, "application/pdf"


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
