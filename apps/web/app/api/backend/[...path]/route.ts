import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, clearSessionCookies, setSessionCookies } from "@/lib/auth/cookies";
import { dispatch } from "@/lib/server/api/dispatch";
import { principalFromAccessToken } from "@/lib/server/auth/principal";
import { AuthService } from "@/lib/server/auth/service";
import { withSession } from "@/lib/server/db/session";
import { AppError } from "@/lib/server/errors";

/**
 * Authenticated entry point into the backend logic in `lib/server/**`.
 *
 * This used to forward every request to a separate FastAPI service, attaching a
 * bearer token and retrying once behind a refresh on a 401. There is no separate
 * service anymore, so there is no upstream 401 to retry behind either — instead this
 * verifies the access-token cookie locally, refreshing first if it's missing/expired,
 * and only then dispatches. Everything the frontend already assumes (paths, method
 * allow-list by construction of `dispatch`, cookie names, the rotated-token
 * cookie-write-back, the error envelope) stays the same.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function envelope(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function resolvePrincipal(req: NextRequest) {
  const access = req.cookies.get(AUTH_COOKIES.access)?.value;
  if (access) {
    const principal = await principalFromAccessToken(access);
    if (principal) return { principal, rotated: null as null | Awaited<ReturnType<AuthService["refresh"]>> };
  }

  const refreshToken = req.cookies.get(AUTH_COOKIES.refresh)?.value;
  if (!refreshToken) return null;

  try {
    const rotated = await withSession((session) => new AuthService(session).refresh(refreshToken));
    const principal = await principalFromAccessToken(rotated.access_token);
    if (!principal) return null;
    return { principal, rotated };
  } catch {
    return null;
  }
}

async function handle(req: NextRequest, params: { path: string[] }, method: string) {
  const resolved = await resolvePrincipal(req);
  if (!resolved) {
    const res = envelope(401, "unauthenticated", "Not signed in.");
    clearSessionCookies(res);
    return res;
  }
  const { principal, rotated } = resolved;

  let body: unknown;
  if (method !== "GET") {
    const contentType = req.headers.get("content-type") ?? "";
    body = contentType.includes("multipart/form-data") ? await req.formData() : await req.json().catch(() => undefined);
  }

  let result;
  try {
    result = await dispatch({ method, segments: params.path, principal, body });
  } catch (err) {
    if (err instanceof AppError) {
      const res = NextResponse.json(err.envelope(), { status: err.statusCode });
      if (rotated) {
        const email = req.cookies.get(AUTH_COOKIES.email)?.value;
        if (email) setSessionCookies(res, { accessToken: rotated.access_token, refreshToken: rotated.refresh_token, email });
      }
      return res;
    }
    console.error(err);
    return envelope(500, "INTERNAL_ERROR", "Unexpected error.");
  }

  const res =
    result.binary !== undefined
      ? new NextResponse(new Uint8Array(result.binary), {
          status: result.status,
          headers: { "content-type": result.contentType ?? "application/octet-stream", "cache-control": "private, no-store" },
        })
      : NextResponse.json(result.json ?? null, { status: result.status, headers: { "cache-control": "private, no-store" } });

  if (rotated) {
    const email = req.cookies.get(AUTH_COOKIES.email)?.value;
    if (email) {
      setSessionCookies(res, { accessToken: rotated.access_token, refreshToken: rotated.refresh_token, email });
    }
  }
  return res;
}

type Context = { params: { path: string[] } };

export const GET = (req: NextRequest, ctx: Context) => handle(req, ctx.params, "GET");
export const POST = (req: NextRequest, ctx: Context) => handle(req, ctx.params, "POST");
export const PATCH = (req: NextRequest, ctx: Context) => handle(req, ctx.params, "PATCH");
