import { describe, expect, it } from "vitest";
import { decayPaint, decayStage, remainingFraction } from "../../shared/decay.ts";

describe("temporal chromatic decay", () => {
  it("reports the fraction of lifespan left", () => {
    expect(remainingFraction(0, 1_000, 0)).toBe(1);
    expect(remainingFraction(0, 1_000, 500)).toBe(0.5);
    expect(remainingFraction(0, 1_000, 1_000)).toBe(0);
  });

  it("clamps a clock that runs past expiry or before send", () => {
    expect(remainingFraction(0, 1_000, 5_000)).toBe(0);
    expect(remainingFraction(0, 1_000, -500)).toBe(1);
  });

  it("treats a non-positive lifespan as spent", () => {
    expect(remainingFraction(1_000, 1_000, 1_000)).toBe(0);
  });

  it("maps each stage at its documented threshold", () => {
    expect(decayStage(1)).toBe("fresh");
    expect(decayStage(0.5)).toBe("fresh");
    expect(decayStage(0.49)).toBe("active");
    expect(decayStage(0.15)).toBe("active");
    expect(decayStage(0.14)).toBe("aging");
    expect(decayStage(0.05)).toBe("aging");
    expect(decayStage(0.04)).toBe("expiring");
  });

  it("pulses only in the final stage, so the motion stays meaningful", () => {
    expect(decayPaint(1).pulse).toBe(false);
    expect(decayPaint(0.2).pulse).toBe(false);
    expect(decayPaint(0.06).pulse).toBe(false);
    expect(decayPaint(0.01).pulse).toBe(true);
  });

  it("produces valid hex at every point on the ramp", () => {
    for (let step = 0; step <= 100; step += 1) {
      const paint = decayPaint(step / 100);
      expect(paint.from).toMatch(/^#[0-9A-F]{6}$/);
      expect(paint.to).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("anchors the terminals to the specified colours", () => {
    expect(decayPaint(1)).toMatchObject({ from: "#22D3EE", to: "#8B5CF6" });
    expect(decayPaint(0)).toMatchObject({ from: "#DC2626", to: "#DC2626" });
  });

  it("carries a text label, so stage is never colour-only", () => {
    expect(decayPaint(1).label).toBe("Fresh");
    expect(decayPaint(0).label).toBe("Expiring");
  });
});
