import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIES } from "@/lib/auth/cookies";
import { decodeAccessClaims } from "@/lib/auth/token";

const LOGIN_PATH = "/login";
const HOME_PATH = "/dashboard";

function unauthorized() {
  return NextResponse.json(
    { error: { code: "unauthenticated", message: "Not signed in." } },
    { status: 401 }
  );
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // The auth handlers manage the session themselves and must stay reachable
  // while signed out.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  // The access cookie can be expired while the refresh cookie is still good, so
  // treat "has a refresh token" as authenticated and let the client refresh.
  const claims = decodeAccessClaims(req.cookies.get(AUTH_COOKIES.access)?.value);
  const hasSession = !!claims || !!req.cookies.get(AUTH_COOKIES.refresh)?.value;
  const isApi = pathname.startsWith("/api/");

  if (pathname === LOGIN_PATH) {
    return hasSession ? NextResponse.redirect(new URL(HOME_PATH, req.url)) : NextResponse.next();
  }

  if (!hasSession) {
    // API callers get a status they can act on; pages get sent to the login form.
    if (isApi) return unauthorized();
    const url = new URL(LOGIN_PATH, req.url);
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals, the auth handlers' own siblings, and
  // static files (which are matched by having a dot in the last segment).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
