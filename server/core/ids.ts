import { randomBytes } from "node:crypto";

/** URL-safe, sortable-enough opaque id. 16 bytes of entropy. */
export function newId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Stable key for a DM between two users, so opening the same DM twice yields one
 * conversation regardless of who initiates.
 */
export function dmPairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}
