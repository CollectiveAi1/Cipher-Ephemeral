/** Wall-clock milliseconds. The authority for every `sentAt` and `expiresAt`. */
export function now(): number {
  return Date.now();
}

const origin = process.hrtime.bigint();

/**
 * Milliseconds since process start, from a monotonic source. Used for elapsed-time
 * windows (rate limits, heartbeats) so an operator adjusting the system clock cannot
 * widen a window or extend a lifespan.
 */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() - origin) / 1e6;
}
