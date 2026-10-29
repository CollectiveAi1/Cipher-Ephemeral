/**
 * Temporal Chromatic Decay — maps a message's remaining lifespan fraction to the
 * colour and motion that carry its state. Pure, so the composer can preview the
 * exact gradient a message will be born with.
 */

type DecayStage = "fresh" | "active" | "aging" | "expiring";

type DecayPaint = {
  readonly stage: DecayStage;
  /** Human-readable stage, so decay is never conveyed by colour alone. */
  readonly label: string;
  readonly from: string;
  readonly to: string;
  /** Breathing pulse runs only in the final stage, so the signal stays meaningful. */
  readonly pulse: boolean;
};

type Anchor = {
  readonly at: number;
  readonly from: string;
  readonly to: string;
};

/** Gradient anchors from full lifespan down to zero; colours lerp between them. */
const ANCHORS: readonly Anchor[] = [
  { at: 1, from: "#22D3EE", to: "#8B5CF6" },
  { at: 0.5, from: "#22D3EE", to: "#14B8A6" },
  { at: 0.15, from: "#14B8A6", to: "#F59E0B" },
  { at: 0.05, from: "#F59E0B", to: "#DC2626" },
  { at: 0, from: "#DC2626", to: "#DC2626" },
];

const STAGE_LABELS: Record<DecayStage, string> = {
  fresh: "Fresh",
  active: "Active",
  aging: "Aging",
  expiring: "Expiring",
};

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const toSrgb = (channel: number) => {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return c * 255;
};

/** Mixes in linear light, which keeps mid-ramp colours bright instead of muddy. */
function mixHex(a: string, b: string, amount: number): string {
  const from = parseHex(a).map(toLinear);
  const to = parseHex(b).map(toLinear);
  const mixed = from.map((channel, i) => channel + (to[i]! - channel) * amount);
  return toHex([toSrgb(mixed[0]!), toSrgb(mixed[1]!), toSrgb(mixed[2]!)]);
}

/** Fraction of lifespan remaining, clamped to [0,1]. */
export function remainingFraction(sentAt: number, expiresAt: number, now: number): number {
  const span = expiresAt - sentAt;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (expiresAt - now) / span));
}

export function decayStage(remaining: number): DecayStage {
  if (remaining >= 0.5) return "fresh";
  if (remaining >= 0.15) return "active";
  if (remaining >= 0.05) return "aging";
  return "expiring";
}

/** Resolves a remaining fraction to its stage and interpolated gradient. */
export function decayPaint(remaining: number): DecayPaint {
  const r = Math.min(1, Math.max(0, remaining));
  const stage = decayStage(r);

  let upper = ANCHORS[0]!;
  let lower = ANCHORS[ANCHORS.length - 1]!;
  for (let i = 0; i < ANCHORS.length - 1; i += 1) {
    const high = ANCHORS[i]!;
    const low = ANCHORS[i + 1]!;
    if (r <= high.at && r >= low.at) {
      upper = high;
      lower = low;
      break;
    }
  }

  const span = upper.at - lower.at;
  const amount = span <= 0 ? 0 : 1 - (r - lower.at) / span;

  return {
    stage,
    label: STAGE_LABELS[stage],
    from: mixHex(upper.from, lower.from, amount),
    to: mixHex(upper.to, lower.to, amount),
    pulse: stage === "expiring",
  };
}
