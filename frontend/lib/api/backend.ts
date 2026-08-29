import { toApiError } from "./errors";

/**
 * Server-side client for the FastAPI service. Used only by the auth route
 * handlers in `app/api/auth/*`, which act as a BFF: the browser never holds a
 * JWT, so tokens cannot be read by script.
 */
const BACKEND_URL = process.env.BACKEND_API_URL ?? "http://localhost:8000";

export async function backendRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = "POST", body } = init;

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A connection failure is the API being down, not bad credentials — say so.
    throw toApiError(503, { error: { code: "backend_unreachable", message: "Authentication service is unavailable." } });
  }

  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, payload);
  return payload as T;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
}
