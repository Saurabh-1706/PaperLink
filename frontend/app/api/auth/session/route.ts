import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES } from "@/lib/auth/cookies";
import { decodeAccessClaims, toAuthUser } from "@/lib/auth/token";

export const runtime = "nodejs";

/** The client's view of who it is. Returns 401 (not an empty user) when signed out. */
export async function GET(req: NextRequest) {
  const claims = decodeAccessClaims(req.cookies.get(AUTH_COOKIES.access)?.value);
  const email = req.cookies.get(AUTH_COOKIES.email)?.value;

  if (!claims || !email) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "Not signed in." } }, { status: 401 });
  }
  return NextResponse.json({ user: toAuthUser(claims, email) });
}
