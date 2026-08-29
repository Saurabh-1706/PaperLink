/**
 * Every path the client talks to, in one place. No component builds a URL.
 *
 * `auth.*` and `pipeline.*` are served by this app's own route handlers under
 * `app/api/`; the auth handlers are a thin BFF in front of the FastAPI service
 * (see lib/api/backend.ts). Moving the pipeline to that service later is a
 * change to these constants plus the adapter, not to any feature code.
 */
export const endpoints = {
  auth: {
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    refresh: "/api/auth/refresh",
    session: "/api/auth/session",
  },
  pipeline: {
    config: "/api/config",
    extractQuestions: "/api/extract-questions",
    extractAnswers: "/api/extract-answers",
    grade: "/api/grade",
  },
} as const;

/** Paths on the upstream FastAPI service (server-side use only). */
export const backendEndpoints = {
  login: "/api/v1/auth/login",
  refresh: "/api/v1/auth/refresh",
} as const;
