import type { NextResponse } from "next/server";

/**
 * Session cookie contract, shared by the auth route handlers and `middleware.ts`.
 * Tokens are httpOnly so no script — ours or injected — can read them.
 */
export const AUTH_COOKIES = {
  access: "va_access",
  refresh: "va_refresh",
  /** Readable by the server only; carries the email, which the JWT does not. */
  email: "va_email",
} as const;

const isProduction = process.env.NODE_ENV === "production";

const BASE = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
} as const;

export function setSessionCookies(
  res: NextResponse,
  tokens: { accessToken: string; refreshToken: string; email: string }
) {
  res.cookies.set(AUTH_COOKIES.access, tokens.accessToken, { ...BASE, maxAge: 60 * 60 });
  res.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, { ...BASE, maxAge: 14 * 24 * 60 * 60 });
  res.cookies.set(AUTH_COOKIES.email, tokens.email, { ...BASE, maxAge: 14 * 24 * 60 * 60 });
}

export function clearSessionCookies(res: NextResponse) {
  for (const name of Object.values(AUTH_COOKIES)) {
    res.cookies.set(name, "", { ...BASE, maxAge: 0 });
  }
}
