/**
 * Typed errors and the uniform error envelope (docs/04-api.md).
 * Port of backend/app/core/errors.py.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    statusCode: number,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  envelope() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.", details: Record<string, unknown> = {}) {
    super("NOT_FOUND", 404, message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Invalid or missing credentials.", details: Record<string, unknown> = {}) {
    super("NOT_AUTHENTICATED", 401, message, details);
  }
}

export class ValidationFailedError extends AppError {
  constructor(message = "Input failed validation.", details: Record<string, unknown> = {}) {
    super("VALIDATION_FAILED", 422, message, details);
  }
}

export class UnsupportedFileError extends AppError {
  constructor(
    message = "Only PDF or JPEG/PNG image uploads are supported.",
    details: Record<string, unknown> = {}
  ) {
    super("UNSUPPORTED_FILE", 415, message, details);
  }
}

export class EncryptedPdfError extends AppError {
  constructor(message = "The uploaded PDF is password protected.", details: Record<string, unknown> = {}) {
    super("ENCRYPTED_PDF", 422, message, details);
  }
}

export class FileTooLargeError extends AppError {
  constructor(message = "The uploaded file exceeds the size cap.", details: Record<string, unknown> = {}) {
    super("FILE_TOO_LARGE", 413, message, details);
  }
}

export class TooManyPagesError extends AppError {
  constructor(message = "The document exceeds the page cap.", details: Record<string, unknown> = {}) {
    super("TOO_MANY_PAGES", 422, message, details);
  }
}

export class CorruptDocumentError extends AppError {
  constructor(message = "The document could not be opened.", details: Record<string, unknown> = {}) {
    super("CORRUPT_DOCUMENT", 422, message, details);
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(message = "A model provider is unavailable.", details: Record<string, unknown> = {}) {
    super("PROVIDER_UNAVAILABLE", 503, message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The request conflicts with current state.", details: Record<string, unknown> = {}) {
    super("CONFLICT", 409, message, details);
  }
}

export class NotImplementedError extends AppError {
  constructor(message = "Not implemented yet.", details: Record<string, unknown> = {}) {
    super("NOT_IMPLEMENTED", 501, message, details);
  }
}
