import { NextRequest, NextResponse } from "next/server";
import { backendRequest, type TokenPair } from "@/lib/api/backend";
import { backendEndpoints } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { setSessionCookies } from "@/lib/auth/cookies";
import { decodeAccessClaims, toAuthUser } from "@/lib/auth/token";

export const runtime = "nodejs";

/** Exchanges credentials for the backend's JWT pair and stores it in httpOnly cookies. */
export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    return NextResponse.json({ error: { code: "invalid_request", message: "Email and password are required." } }, { status: 400 });
  }

  try {
    const tokens = await backendRequest<TokenPair>(backendEndpoints.login, {
      body: { email, password },
    });

    const claims = decodeAccessClaims(tokens.access_token);
    if (!claims) {
      return NextResponse.json({ error: { code: "invalid_token", message: "The API returned an unreadable token." } }, { status: 502 });
    }

    const res = NextResponse.json({ user: toAuthUser(claims, email) });
    setSessionCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email,
    });
    return res;
  } catch (err) {
    // Keep the upstream code: a 503 from an unreachable API must not be
    // reported to the UI as though the credentials were rejected.
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : "Login failed.";
    const code = err instanceof ApiError ? err.code : "authentication_failed";
    return NextResponse.json({ error: { code, message } }, { status });
  }
}
