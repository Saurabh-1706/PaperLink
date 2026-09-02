import { cookies } from "next/headers";
import { AUTH_COOKIES } from "./cookies";
import { decodeAccessClaims, toAuthUser } from "./token";
import type { AuthUser } from "@/types";

/**
 * The session as seen by a Server Component. Used by the app layout so the
 * first paint already knows who is signed in.
 */
export function getServerSession(): AuthUser | null {
  const store = cookies();
  const claims = decodeAccessClaims(store.get(AUTH_COOKIES.access)?.value);
  const email = store.get(AUTH_COOKIES.email)?.value;
  if (!claims || !email) return null;
  return toAuthUser(claims, email);
}
