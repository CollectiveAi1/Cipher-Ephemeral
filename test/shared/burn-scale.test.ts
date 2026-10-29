import { describe, expect, it } from "vitest";
import {
  dialPositionToSeconds,
  formatLifespan,
  formatRemaining,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  NOTCH_SECONDS,
  quantizeSeconds,
  secondsToDialPosition,
  snapToNotch,
  stepNotch,
} from "../../shared/burn-scale.ts";

describe("burn scale", () => {
  it("spans exactly 15 seconds to 7 days", () => {
    expect(dialPositionToSeconds(0)).toBe(MIN_TTL_SECONDS);
    expect(dialPositionToSeconds(1)).toBe(MAX_TTL_SECONDS);
  });

  it("clamps positions outside the track", () => {
    expect(dialPositionToSeconds(-5)).toBe(MIN_TTL_SECONDS);
    expect(dialPositionToSeconds(42)).toBe(MAX_TTL_SECONDS);
  });

  it("round-trips every notch exactly", () => {
    for (const notch of NOTCH_SECONDS) {
      expect(dialPositionToSeconds(secondsToDialPosition(notch))).toBe(notch);
    }
  });

  it("is monotonically increasing across the track", () => {
    let previous = 0;
    for (let step = 0; step <= 100; step += 1) {
      const seconds = dialPositionToSeconds(step / 100);
      expect(seconds).toBeGreaterThanOrEqual(previous);
      previous = seconds;
    }
  });

  it("places each band at its documented boundary", () => {
    expect(dialPositionToSeconds(0.25)).toBe(300);
    expect(dialPositionToSeconds(0.5)).toBe(3_600);
    expect(dialPositionToSeconds(0.75)).toBe(86_400);
  });

  it("gives the flash band fine resolution where it matters", () => {
    // A quarter of the dial covers 15s to 5m, so short lifespans are selectable.
    expect(dialPositionToSeconds(0.05)).toBeLessThan(60);
    expect(dialPositionToSeconds(0.2)).toBeGreaterThan(120);
  });

  it("quantizes to readable steps and preserves notches", () => {
    expect(quantizeSeconds(17)).toBe(15);
    expect(quantizeSeconds(263)).toBe(270); // under 5m, rounded to the nearest 15s
    expect(quantizeSeconds(4_000)).toBe(3_900); // under 24h, rounded to the nearest 5m
    for (const notch of NOTCH_SECONDS) expect(quantizeSeconds(notch)).toBe(notch);
  });

  it("snaps to a notch only within tolerance", () => {
    const oneHour = secondsToDialPosition(3_600);
    expect(dialPositionToSeconds(snapToNotch(oneHour + 0.002, 0.005))).toBe(3_600);
    expect(snapToNotch(0.4, 0.005)).toBe(0.4);
  });

  it("steps between notches and stops at the ends", () => {
    expect(stepNotch(15, 1)).toBe(60);
    expect(stepNotch(60, -1)).toBe(15);
    expect(stepNotch(MIN_TTL_SECONDS, -1)).toBe(MIN_TTL_SECONDS);
    expect(stepNotch(MAX_TTL_SECONDS, 1)).toBe(MAX_TTL_SECONDS);
  });

  it("formats lifespans compactly", () => {
    expect(formatLifespan(15)).toBe("15s");
    expect(formatLifespan(300)).toBe("5m");
    expect(formatLifespan(3_600)).toBe("1h");
    expect(formatLifespan(604_800)).toBe("7d");
  });

  it("formats countdowns to two units", () => {
    expect(formatRemaining(42)).toBe("42s");
    expect(formatRemaining(303)).toBe("5m 03s");
    expect(formatRemaining(130_000)).toBe("1d 12h");
    expect(formatRemaining(-10)).toBe("0s");
  });
});
