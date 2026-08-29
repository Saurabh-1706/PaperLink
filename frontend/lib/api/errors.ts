/**
 * A single error shape for the whole client. Both error envelopes in play are
 * normalised into this: the backend's `{"error": {code, message, details}}`
 * (docs/04-api.md) and the Next route handlers' flat `{"error": "message"}`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code = "error", details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

export function toApiError(status: number, body: unknown): ApiError {
  const envelope = (body as { error?: unknown } | null)?.error;

  if (envelope && typeof envelope === "object") {
    const e = envelope as { code?: string; message?: string; details?: unknown };
    return new ApiError(e.message ?? "Request failed", status, e.code ?? "error", e.details);
  }
  if (typeof envelope === "string") {
    return new ApiError(envelope, status);
  }
  return new ApiError(`Request failed with status ${status}`, status);
}

/** Never leak a raw object into the UI — every catch funnels through this. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
