import { randomBytes } from "node:crypto";
import { MAX_TTL_SECONDS } from "../shared/burn-scale.ts";

const number = (raw: string | undefined, fallback: number) => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received "${raw}"`);
  return parsed;
};

const boolean = (raw: string | undefined, fallback: boolean) => {
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "true" || raw === "1";
};

function resolveSecret(): string {
  const secret = process.env["CIPHER_TOKEN_SECRET"];
  if (secret !== undefined && secret.length >= 32) return secret;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("CIPHER_TOKEN_SECRET must be set to at least 32 characters in production");
  }
  // Ephemeral development secret: restarting invalidates existing sessions, which is
  // the correct failure mode for a secret nobody configured.
  return randomBytes(32).toString("hex");
}

export const env = {
  port: number(process.env["CIPHER_PORT"], 8787),
  dbPath: process.env["CIPHER_DB_PATH"] ?? "./data/cipher.db",
  tokenSecret: resolveSecret(),
  maxTtlSeconds: Math.min(MAX_TTL_SECONDS, number(process.env["CIPHER_MAX_TTL_SECONDS"], MAX_TTL_SECONDS)),
  serveStatic: boolean(process.env["CIPHER_SERVE_STATIC"], false),
  /**
   * Enable only when Cipher sits behind a proxy you control. It makes Express read
   * X-Forwarded-For, which a client can forge when nothing strips it — and that address
   * is what the rate limiter keys on.
   */
  trustProxy: boolean(process.env["CIPHER_TRUST_PROXY"], false),
  /**
   * STUN/TURN URLs for call connectivity. Empty by default: a STUN server learns the
   * caller's address, so reaching past NAT is an explicit choice rather than one made
   * silently on the user's behalf. With none configured, calls work on a local network.
   */
  iceServers: (process.env["CIPHER_ICE_SERVERS"] ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== ""),
  /**
   * Browser origins allowed to call this server, for when the UI is hosted separately.
   * Empty means same-origin only — no cross-origin browser client is permitted, which
   * is the right default for a single-process deployment.
   */
  allowedOrigins: (process.env["CIPHER_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter((origin) => origin !== ""),
  isTest: process.env["NODE_ENV"] === "test",
} as const;
