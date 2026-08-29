/**
 * Every path the client talks to, in one place. No component builds a URL.
 *
 * `auth.*` are this app's own route handlers (a BFF in front of FastAPI: the
 * browser never holds a JWT). Everything else is a real FastAPI route, reached
 * through the authenticated proxy at `app/api/backend/[...path]` — `v1.*`
 * returns the path *on the backend*, and `proxied()` prefixes it.
 */

/** Mount point of the proxy route handler. */
export const PROXY_PREFIX = "/api/backend";

/** The `/api/v1` prefix the proxy prepends before calling FastAPI. */
export const BACKEND_API_PREFIX = "/api/v1";

const id = encodeURIComponent;

export const endpoints = {
  auth: {
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    refresh: "/api/auth/refresh",
    session: "/api/auth/session",
  },
} as const;

/** Paths on the upstream FastAPI service, without the `/api/v1` prefix. */
export const v1 = {
  assessments: () => "/assessments",
  assessment: (assessmentId: string) => `/assessments/${id(assessmentId)}`,
  questionPaper: (assessmentId: string) => `/assessments/${id(assessmentId)}/question-paper`,
  answerSheet: (assessmentId: string) => `/assessments/${id(assessmentId)}/answer-sheet`,
  process: (assessmentId: string) => `/assessments/${id(assessmentId)}/process`,
  remap: (assessmentId: string) => `/assessments/${id(assessmentId)}/remap`,
  job: (assessmentId: string, jobId: string) =>
    `/assessments/${id(assessmentId)}/jobs/${id(jobId)}`,
  questions: (assessmentId: string) => `/assessments/${id(assessmentId)}/questions`,
  answers: (assessmentId: string) => `/assessments/${id(assessmentId)}/answers`,
  mappings: (assessmentId: string) => `/assessments/${id(assessmentId)}/mappings`,
  grades: (assessmentId: string) => `/assessments/${id(assessmentId)}/grades`,
  results: (assessmentId: string) => `/assessments/${id(assessmentId)}/results`,
  mapping: (mappingId: string) => `/mappings/${id(mappingId)}`,
  pageImage: (documentId: string, pageNumber: number) =>
    `/documents/${id(documentId)}/pages/${pageNumber}/image`,
  documentMarkdown: (documentId: string) => `/documents/${id(documentId)}/markdown`,
} as const;

/** Turns a `v1.*` path into one the browser can call. */
export function proxied(path: string): string {
  return `${PROXY_PREFIX}${path}`;
}

/** Auth paths, called server-side only (the proxy never forwards these). */
export const backendEndpoints = {
  login: `${BACKEND_API_PREFIX}/auth/login`,
  refresh: `${BACKEND_API_PREFIX}/auth/refresh`,
} as const;
