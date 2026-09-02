/**
 * Password hashing and JWT issuing/verification. Port of backend/app/core/security.py.
 *
 * Argon2 (not bcrypt) to match the Python side's hashing scheme, via `@node-rs/argon2`
 * — a napi-rs package with prebuilt binaries per platform (including Vercel's Node
 * runtime), avoiding the node-gyp native-compile risk a plain `argon2` package would
 * carry there.
 */
import { hash, verify } from "@node-rs/argon2";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomUUID } from "crypto";
import { settings } from "@/lib/server/config";
import { AuthenticationError } from "@/lib/server/errors";

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

export interface AccessClaims extends JWTPayload {
  sub: string;
  org: string;
  type: "access" | "refresh";
}

const secret = () => new TextEncoder().encode(settings.jwtSecret);

async function encode(subject: string, orgId: string, ttlSeconds: number, type: "access" | "refresh") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: subject, org: orgId, type, jti: randomUUID().replace(/-/g, "") })
    .setProtectedHeader({ alg: settings.jwtAlgorithm })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secret());
}

export function createAccessToken(subject: string, orgId: string): Promise<string> {
  return encode(subject, orgId, settings.jwtAccessTtlSeconds, "access");
}

export function createRefreshToken(subject: string, orgId: string): Promise<string> {
  return encode(subject, orgId, settings.jwtRefreshTtlSeconds, "refresh");
}

export async function decodeToken(
  token: string,
  expectedType: "access" | "refresh" = "access"
): Promise<AccessClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { algorithms: [settings.jwtAlgorithm] }));
  } catch {
    throw new AuthenticationError("Token is invalid or expired.");
  }
  if (payload.type !== expectedType) throw new AuthenticationError("Wrong token type.");
  return payload as AccessClaims;
}
