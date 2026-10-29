/**
 * The Burn Dial scale — the single source of truth for mapping dial position to
 * message lifespan. Imported by the composer (rendering, keyboard stepping) and by
 * the server (TTL validation), so the two can never disagree.
 *
 * Within each band, seconds interpolate geometrically: `lo * (hi/lo)^u`. That gives
 * constant *proportional* resolution, so a given arc length is the same relative
 * change anywhere on the dial.
 */

export const MIN_TTL_SECONDS = 15;
export const MAX_TTL_SECONDS = 604_800; // 7 days

type Band = {
  readonly from: number;
  readonly to: number;
  readonly lo: number;
  readonly hi: number;
};

const BANDS: readonly Band[] = [
  { from: 0, to: 0.25, lo: MIN_TTL_SECONDS, hi: 300 }, // flash:       15s -> 5m
  { from: 0.25, to: 0.5, lo: 300, hi: 3_600 }, // tactical:    5m  -> 1h
  { from: 0.5, to: 0.75, lo: 3_600, hi: 86_400 }, // working day: 1h  -> 24h
  { from: 0.75, to: 1, lo: 86_400, hi: MAX_TTL_SECONDS }, // extended:    24h -> 7d
];

/** Detents the dial snaps to and that arrow keys step between. */
export const NOTCH_SECONDS: readonly number[] = [15, 60, 300, 3_600, 43_200, 86_400, 604_800];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Rounds to a step that reads cleanly at its magnitude, so the dial never yields
 * values like `4m 23s`. Exact notch values are always preserved.
 */
export function quantizeSeconds(seconds: number): number {
  const step = seconds < 60 ? 5 : seconds < 300 ? 15 : seconds < 3_600 ? 60 : seconds < 86_400 ? 300 : 3_600;
  const rounded = Math.round(seconds / step) * step;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, rounded));
}

/** Maps a normalized dial position to a lifespan in seconds. */
export function dialPositionToSeconds(position: number): number {
  const t = clamp01(position);
  const band = BANDS.find((candidate) => t <= candidate.to) ?? BANDS[BANDS.length - 1]!;
  const u = (t - band.from) / (band.to - band.from);
  return quantizeSeconds(band.lo * Math.pow(band.hi / band.lo, u));
}

/** Exact inverse of {@link dialPositionToSeconds} for any in-range lifespan. */
export function secondsToDialPosition(seconds: number): number {
  const s = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, seconds));
  const band = BANDS.find((candidate) => s <= candidate.hi) ?? BANDS[BANDS.length - 1]!;
  const u = Math.log(s / band.lo) / Math.log(band.hi / band.lo);
  return clamp01(band.from + u * (band.to - band.from));
}

/** Snaps a dial position to the nearest notch when it lands within `tolerance`. */
export function snapToNotch(position: number, tolerance: number): number {
  let best = position;
  let bestDistance = tolerance;
  for (const notch of NOTCH_SECONDS) {
    const notchPosition = secondsToDialPosition(notch);
    const distance = Math.abs(notchPosition - position);
    if (distance < bestDistance) {
      best = notchPosition;
      bestDistance = distance;
    }
  }
  return best;
}

/** Moves one notch up or down from the current lifespan. */
export function stepNotch(seconds: number, direction: 1 | -1): number {
  const ordered = direction === 1 ? [...NOTCH_SECONDS] : [...NOTCH_SECONDS].reverse();
  const next = ordered.find((notch) => (direction === 1 ? notch > seconds : notch < seconds));
  return next ?? seconds;
}

/** Compact lifespan label for the dial hub: `15s`, `5m`, `1h`, `7d`. */
export function formatLifespan(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** Two-unit countdown for message tickers: `1d 12h`, `5m 03s`, `42s`. */
export function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}
