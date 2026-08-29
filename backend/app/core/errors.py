"""Typed errors and the uniform error envelope (docs/04-api.md)."""
from __future__ import annotations

from typing import Any


class AppError(Exception):
    code = "INTERNAL_ERROR"
    status_code = 500
    message = "Unexpected error."

    def __init__(self, message: str | None = None, **details: Any) -> None:
        self.message = message or self.message
        self.details = details
        super().__init__(self.message)

    def envelope(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class NotFoundError(AppError):
    code, status_code, message = "NOT_FOUND", 404, "Resource not found."


class PermissionDeniedError(AppError):
    code, status_code, message = "PERMISSION_DENIED", 403, "Insufficient role."


class AuthenticationError(AppError):
    code, status_code, message = "NOT_AUTHENTICATED", 401, "Invalid or missing credentials."


class ValidationFailedError(AppError):
    code, status_code, message = "VALIDATION_FAILED", 422, "Input failed validation."


class UnsupportedFileError(AppError):
    code, status_code, message = "UNSUPPORTED_FILE", 415, "Only PDF uploads are supported."


class EncryptedPdfError(AppError):
    code, status_code, message = "ENCRYPTED_PDF", 422, "The uploaded PDF is password protected."


class FileTooLargeError(AppError):
    code, status_code, message = "FILE_TOO_LARGE", 413, "The uploaded file exceeds the size cap."


class TooManyPagesError(AppError):
    code, status_code, message = "TOO_MANY_PAGES", 422, "The document exceeds the page cap."


class CorruptDocumentError(AppError):
    code, status_code, message = "CORRUPT_DOCUMENT", 422, "The document could not be opened."


class StageFailedError(AppError):
    code, status_code, message = "STAGE_FAILED", 500, "A pipeline stage failed."


class ProviderUnavailableError(AppError):
    code, status_code, message = "PROVIDER_UNAVAILABLE", 503, "A model provider is unavailable."


class ConflictError(AppError):
    code, status_code, message = "CONFLICT", 409, "The request conflicts with current state."
