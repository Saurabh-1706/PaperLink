import { NextRequest, NextResponse } from "next/server";
import { BACKEND_API_PREFIX, backendEndpoints } from "@/lib/api/endpoints";
import { AUTH_COOKIES, clearSessionCookies, setSessionCookies } from "@/lib/auth/cookies";
import type { TokenPair } from "@/lib/api/backend";

/**
 * Authenticated pass-through to the FastAPI service.
 *
 * The browser holds an httpOnly session cookie, never a JWT, so something has
 * to attach the bearer token — this route does, and only this route. It also
 * absorbs a token expiring mid-run: a 401 from the backend is retried once
 * behind a refresh, and the rotated pair is written back to the cookies.
 *
 * The allowlist below is defence in depth. The backend enforces tenancy and
 * RBAC on every route it owns; the list keeps this proxy from being a general
 * tunnel to routes the UI never intended to expose (`/auth/*` in particular,
 * which has its own BFF handlers because it manages cookies).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.BACKEND_API_URL ?? "http://localhost:8000";

/** Entity ids are hex uuids; page numbers are digits. */
const ID = "[A-Za-z0-9_-]+";

const ALLOWED: readonly { methods: readonly string[]; pattern: RegExp }[] = [
  { methods: ["POST"], pattern: new RegExp(`^/assessments$`) },
  { methods: ["GET"], pattern: new RegExp(`^/assessments/${ID}$`) },
  {
    methods: ["POST"],
    pattern: new RegExp(`^/assessments/${ID}/(question-paper|answer-sheet|process|remap)$`),
  },
  { methods: ["GET"], pattern: new RegExp(`^/assessments/${ID}/jobs/${ID}$`) },
  {
    methods: ["GET"],
    pattern: new RegExp(`^/assessments/${ID}/(questions|answers|mappings|grades|results)$`),
  },
  { methods: ["PATCH"], pattern: new RegExp(`^/mappings/${ID}$`) },
  { methods: ["GET"], pattern: new RegExp(`^/documents/${ID}/pages/\\d+/image$`) },
  { methods: ["GET"], pattern: new RegExp(`^/documents/${ID}/markdown$`) },
];

function isAllowed(method: string, path: string): boolean {
  return ALLOWED.some((rule) => rule.methods.includes(method) && rule.pattern.test(path));
}

function envelope(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function refreshTokens(refreshToken: string | undefined): Promise<TokenPair | null> {
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${BACKEND_URL}${backendEndpoints.refresh}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return res.ok ? ((await res.json()) as TokenPair) : null;
  } catch {
    return null;
  }
}

async function handle(req: NextRequest, params: { path: string[] }, method: string) {
  const path = `/${params.path.map(encodeURIComponent).join("/")}`;

  if (!isAllowed(method, path)) {
    return envelope(404, "not_found", "No such endpoint.");
  }

  const accessToken = req.cookies.get(AUTH_COOKIES.access)?.value;
  if (!accessToken) {
    return envelope(401, "unauthenticated", "Not signed in.");
  }

  // Read the body once and reuse the buffer for the post-refresh retry. Passing
  // the raw bytes through (rather than re-encoding) keeps a multipart upload's
  // boundary intact.
  const body = method === "GET" ? undefined : Buffer.from(await req.arrayBuffer());
  const contentType = req.headers.get("content-type");
  const url = `${BACKEND_URL}${BACKEND_API_PREFIX}${path}${req.nextUrl.search}`;

  const call = (token: string) =>
    fetch(url, {
      method,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        ...(contentType ? { "content-type": contentType } : {}),
      },
      body,
    });

  let upstream: Response;
  try {
    upstream = await call(accessToken);
  } catch {
    return envelope(503, "backend_unreachable", "The assessment service is unavailable.");
  }

  let rotated: TokenPair | null = null;
  if (upstream.status === 401) {
    rotated = await refreshTokens(req.cookies.get(AUTH_COOKIES.refresh)?.value);
    if (rotated) {
      try {
        upstream = await call(rotated.access_token);
      } catch {
        return envelope(503, "backend_unreachable", "The assessment service is unavailable.");
      }
    }
  }

  // Binary passes through untouched — the page-image route returns PNG bytes.
  const payload = await upstream.arrayBuffer();
  const res = new NextResponse(payload, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, no-store",
    },
  });

  if (rotated) {
    const email = req.cookies.get(AUTH_COOKIES.email)?.value;
    if (email) {
      setSessionCookies(res, {
        accessToken: rotated.access_token,
        refreshToken: rotated.refresh_token,
        email,
      });
    }
  } else if (upstream.status === 401) {
    // The token was rejected and could not be renewed: the session is over.
    clearSessionCookies(res);
  }

  return res;
}

type Context = { params: { path: string[] } };

export const GET = (req: NextRequest, ctx: Context) => handle(req, ctx.params, "GET");
export const POST = (req: NextRequest, ctx: Context) => handle(req, ctx.params, "POST");
export const PATCH = (req: NextRequest, ctx: Context) => handle(req, ctx.params, "PATCH");
