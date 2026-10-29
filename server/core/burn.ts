import { MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../../shared/burn-scale.ts";
import type { BurnMode } from "../../shared/protocol.ts";
import { env } from "../env.ts";

/**
 * Ceiling applied to on-read messages so one that is never opened cannot sit on the
 * server indefinitely.
 */
export const ON_READ_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Clamps a client-proposed lifespan into the workspace retention policy. */
export function clampTtlSeconds(requested: number): number {
  if (!Number.isFinite(requested)) return MIN_TTL_SECONDS;
  const ceiling = Math.min(MAX_TTL_SECONDS, env.maxTtlSeconds);
  return Math.round(Math.min(ceiling, Math.max(MIN_TTL_SECONDS, requested)));
}

type BurnSchedule = {
  /** Effective expiry, or null when an on-read timer has not started. */
  expiresAt: number | null;
  /** Hard ceiling enforced by the reaper regardless of read state. */
  hardExpiresAt: number;
};

export function scheduleBurn(sentAt: number, ttlSeconds: number, mode: BurnMode): BurnSchedule {
  const ttlMs = ttlSeconds * 1000;
  if (mode === "absolute") {
    return { expiresAt: sentAt + ttlMs, hardExpiresAt: sentAt + ttlMs };
  }
  return { expiresAt: null, hardExpiresAt: sentAt + ttlMs + ON_READ_GRACE_MS };
}

/**
 * Expiry for an on-read message at the moment the first recipient reads it. Never
 * extends past the hard ceiling the sender was already promised.
 */
export function startOnReadBurn(readAt: number, ttlSeconds: number, hardExpiresAt: number): number {
  return Math.min(hardExpiresAt, readAt + ttlSeconds * 1000);
}
