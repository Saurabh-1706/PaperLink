import type { AuthUser } from "@/types";

/**
 * JWT claims issued by `lib/server/auth/security.ts`.
 * There is no name claim — the display name is derived from the email.
 */
export interface AccessClaims {
  sub: string;
  org: string;
  type: "access" | "refresh";
  exp: number;
}

/**
 * Decodes the payload WITHOUT verifying the signature.
 *
 * That is deliberate and safe here: the token is only ever read to decide what
 * chrome to render and which routes to show. The signature is verified by the
 * API on every request (`decode_token` in app/core/security.py), which is the
 * only place a forged token could actually buy anything. Runs on the edge, so
 * it must stay dependency-free.
 */
export function decodeAccessClaims(token: string | undefined): AccessClaims | null {
  if (!token) return null;
  const segment = token.split(".")[1];
  if (!segment) return null;

  try {
    const json = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as Partial<AccessClaims>;
    if (!claims.sub || !claims.org) return null;
    if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
    return claims as AccessClaims;
  } catch {
    return null;
  }
}

/** "ada.lovelace@school.org" → "Ada Lovelace" */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || email
  );
}

export function toAuthUser(claims: AccessClaims, email: string): AuthUser {
  return {
    id: claims.sub,
    organizationId: claims.org,
    email,
    name: displayNameFromEmail(email),
  };
}
