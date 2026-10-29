import { describe, expect, it } from "vitest";
import { hashPassword, newSalt, verifyPassword } from "../../server/core/passwords.ts";
import { hashToken, issueToken, verifyToken } from "../../server/core/tokens.ts";
import { clampTtlSeconds, ON_READ_GRACE_MS, scheduleBurn, startOnReadBurn } from "../../server/core/burn.ts";
import { dmPairKey, newId } from "../../server/core/ids.ts";
import { monotonicMs } from "../../server/core/time.ts";

describe("passwords", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const salt = newSalt();
    const hash = await hashPassword("correct horse battery staple", salt);
    expect(await verifyPassword("correct horse battery staple", salt, hash)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", salt, hash)).toBe(false);
  });

  it("produces a different hash per salt, so identical passwords do not collide", async () => {
    const first = await hashPassword("same-password", newSalt());
    const second = await hashPassword("same-password", newSalt());
    expect(first).not.toBe(second);
  });

  it("rejects a hash of the wrong length without throwing", async () => {
    expect(await verifyPassword("whatever", newSalt(), "c2hvcnQ=")).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips the subject", () => {
    const { token } = issueToken("user-1");
    expect(verifyToken(token)?.sub).toBe("user-1");
  });

  it("rejects a tampered payload", () => {
    const { token } = issueToken("user-1");
    const [body, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin", jti: "x", exp: Date.now() + 10_000 })).toString(
      "base64url",
    );
    expect(verifyToken(`${forged}.${signature}`)).toBeNull();
    expect(verifyToken(`${body}.${"A".repeat(43)}`)).toBeNull();
  });

  it("rejects malformed input instead of throwing", () => {
    expect(verifyToken("")).toBeNull();
    expect(verifyToken("no-separator")).toBeNull();
    expect(verifyToken(".abc")).toBeNull();
  });

  it("stores a digest rather than the token itself", () => {
    const { token } = issueToken("user-1");
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(hashToken(token));
  });
});

describe("burn policy", () => {
  it("clamps a lifespan into the supported range", () => {
    expect(clampTtlSeconds(1)).toBe(15);
    expect(clampTtlSeconds(99_999_999)).toBe(604_800);
    expect(clampTtlSeconds(Number.NaN)).toBe(15);
  });

  it("schedules an absolute burn from the send time", () => {
    expect(scheduleBurn(1_000, 60, "absolute")).toEqual({ expiresAt: 61_000, hardExpiresAt: 61_000 });
  });

  it("leaves an on-read burn unarmed but still ceilinged", () => {
    const schedule = scheduleBurn(1_000, 60, "onRead");
    expect(schedule.expiresAt).toBeNull();
    expect(schedule.hardExpiresAt).toBe(1_000 + 60_000 + ON_READ_GRACE_MS);
  });

  it("starts an on-read burn at first read without passing the ceiling", () => {
    expect(startOnReadBurn(5_000, 60, 10_000_000)).toBe(65_000);
    // A read that arrives near the ceiling cannot extend past what the sender was promised.
    expect(startOnReadBurn(5_000, 60, 20_000)).toBe(20_000);
  });
});

describe("identifiers and time", () => {
  it("generates unique url-safe ids", () => {
    const ids = new Set(Array.from({ length: 500 }, newId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds the same DM key regardless of who initiates", () => {
    expect(dmPairKey("b", "a")).toBe(dmPairKey("a", "b"));
    expect(dmPairKey("a", "b")).not.toBe(dmPairKey("a", "c"));
  });

  it("advances monotonically", () => {
    const first = monotonicMs();
    const second = monotonicMs();
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
