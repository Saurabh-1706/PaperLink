import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/server/errors";
import { AuthService } from "@/lib/server/auth/service";
import { withSession } from "@/lib/server/db/session";
import { setSessionCookies } from "@/lib/auth/cookies";
import { decodeAccessClaims, toAuthUser } from "@/lib/auth/token";

export const runtime = "nodejs";

/** Exchanges credentials for a JWT pair and stores it in httpOnly cookies. */
export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    return NextResponse.json({ error: { code: "invalid_request", message: "Email and password are required." } }, { status: 400 });
  }

  try {
    const tokens = await withSession((session) => new AuthService(session).login(email, password));

    const claims = decodeAccessClaims(tokens.access_token);
    if (!claims) {
      return NextResponse.json({ error: { code: "invalid_token", message: "An unreadable token was issued." } }, { status: 502 });
    }

    const res = NextResponse.json({ user: toAuthUser(claims, email) });
    setSessionCookies(res, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email,
    });
    return res;
  } catch (err) {
    const status = err instanceof AppError ? err.statusCode : 500;
    const message = err instanceof AppError ? err.message : "Login failed.";
    const code = err instanceof AppError ? err.code : "authentication_failed";
    return NextResponse.json({ error: { code, message } }, { status });
  }
}
