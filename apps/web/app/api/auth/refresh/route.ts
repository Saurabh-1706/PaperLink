import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/server/auth/service";
import { withSession } from "@/lib/server/db/session";
import { AUTH_COOKIES, clearSessionCookies, setSessionCookies } from "@/lib/auth/cookies";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";

/** Rotates the token pair. Called by lib/api/httpClient on a 401, once. */
export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(AUTH_COOKIES.refresh)?.value;
  const email = req.cookies.get(AUTH_COOKIES.email)?.value;

  if (!refreshToken || !email) {
    const res = NextResponse.json({ error: { code: "no_session", message: "No session to refresh." } }, { status: 401 });
    clearSessionCookies(res);
    return res;
  }

  try {
    const tokens = await withSession((session) => new AuthService(session).refresh(refreshToken));
    const res = NextResponse.json({ ok: true });
    setSessionCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email,
    });
    return res;
  } catch (err) {
    if (err instanceof AppError) {
      // A genuinely invalid/expired token is a session that is over — drop it
      // rather than leaving a stale cookie that keeps failing.
      const res = NextResponse.json({ error: { code: "session_expired", message: "Session expired." } }, { status: 401 });
      clearSessionCookies(res);
      return res;
    }
    // An unexpected failure (e.g. the database being unreachable) is not proof the
    // session is invalid — log it and let the client retry instead of force-logging
    // the user out over a transient infrastructure problem.
    console.error("[auth/refresh] unexpected error:", err);
    return NextResponse.json({ error: { code: "internal_error", message: "Could not refresh the session." } }, { status: 503 });
  }
}
