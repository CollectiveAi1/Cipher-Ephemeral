import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env.ts";
import { now } from "./time.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type TokenClaims = {
  /** User id. */
  sub: string;
  /** Token id, so a single session can be revoked without touching the others. */
  jti: string;
  /** Expiry, epoch ms. */
  exp: number;
};

const sign = (body: string) => createHmac("sha256", env.tokenSecret).update(body).digest("base64url");

export function issueToken(userId: string): { token: string; expiresAt: number } {
  const claims: TokenClaims = {
    sub: userId,
    jti: randomBytes(12).toString("base64url"),
    exp: now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${body}.${sign(body)}`, expiresAt: claims.exp };
}

/**
 * Verifies signature and expiry. A valid signature alone does not authorize a
 * request — the caller must also confirm the session row still exists, which is how
 * logout revokes a token that has not yet expired.
 */
export function verifyToken(token: string): TokenClaims | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(body), "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenClaims;
    if (typeof claims.sub !== "string" || typeof claims.jti !== "string" || typeof claims.exp !== "number") {
      return null;
    }
    return claims.exp > now() ? claims : null;
  } catch {
    return null;
  }
}

/** Sessions are stored as digests, so a database leak cannot replay live tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}
