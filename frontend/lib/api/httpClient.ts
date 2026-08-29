import { endpoints } from "./endpoints";
import { ApiError, toApiError } from "./errors";

/**
 * The one place the app calls `fetch`. Features call typed service functions
 * (features/<name>/api/*), those call this. Nothing else in the app knows about
 * headers, status codes, or JSON parsing.
 */

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON by default; a `FormData` body is sent as multipart untouched. */
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: prevents an infinite refresh loop. */
  _retried?: boolean;
}

/** The browser sets multipart's boundary itself — naming a content-type breaks it. */
function encodeBody(body: unknown): { body?: BodyInit; headers?: HeadersInit } {
  if (body === undefined) return {};
  if (body instanceof FormData) return { body };
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}

/**
 * Empty by default: requests go to this app's own route handlers. Point it at
 * the FastAPI service to bypass them.
 */
const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

let refreshInFlight: Promise<boolean> | null = null;

/** Refresh once for concurrent 401s rather than once per request. */
async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch(endpoints.auth.refresh, { method: "POST" })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options;

  const encoded = encodeBody(body);

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    signal,
    // Session cookies are httpOnly and set by the BFF; they ride along here.
    credentials: "same-origin",
    headers: encoded.headers,
    body: encoded.body,
  });

  if (res.status === 401 && !options._retried && path !== endpoints.auth.refresh) {
    if (await refreshSession()) {
      return request<T>(path, { ...options, _retried: true });
    }
  }

  const payload = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) throw toApiError(res.status, payload);

  return payload as T;
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  del: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "DELETE" }),
};

export { ApiError };
