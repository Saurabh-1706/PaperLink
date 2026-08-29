import { NextRequest, NextResponse } from "next/server";
import { backendRequest, type TokenPair } from "@/lib/api/backend";
import { backendEndpoints } from "@/lib/api/endpoints";
import { AUTH_COOKIES, clearSessionCookies, setSessionCookies } from "@/lib/auth/cookies";

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
    const tokens = await backendRequest<TokenPair>(backendEndpoints.refresh, {
      body: { refresh_token: refreshToken },
    });
    const res = NextResponse.json({ ok: true });
    setSessionCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email,
    });
    return res;
  } catch {
    // A refresh that fails is a session that is over — drop it rather than
    // leaving a stale cookie that keeps failing.
    const res = NextResponse.json({ error: { code: "session_expired", message: "Session expired." } }, { status: 401 });
    clearSessionCookies(res);
    return res;
  }
}
