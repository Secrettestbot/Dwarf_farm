import { describe, it, expect } from "vitest";
import {
  KINGDOMS,
  kingdomByName,
  reputationPriceMultiplier,
  REPUTATION_MIN,
  REPUTATION_MAX,
} from "./kingdoms";

describe("kingdom profile table", () => {
  it("has at least 8 distinct kingdoms with non-empty names", () => {
    expect(KINGDOMS.length).toBeGreaterThanOrEqual(8);
    const names = new Set(KINGDOMS.map((k) => k.name));
    expect(names.size).toBe(KINGDOMS.length);
    for (const k of KINGDOMS) expect(k.name.length).toBeGreaterThan(0);
  });

  it("every kingdom declares at least one preferred import", () => {
    for (const k of KINGDOMS) {
      expect(k.preferredImports.length).toBeGreaterThan(0);
    }
  });

  it("kingdomByName returns the right entry and null for misses", () => {
    expect(kingdomByName("the Iron Vaults of Karnesh")?.buys.ore).toBeGreaterThan(1);
    expect(kingdomByName("Nowhere")).toBeNull();
  });
});

describe("reputation price multiplier curve", () => {
  it("is exactly 1.0 at rep 0", () => {
    expect(reputationPriceMultiplier(0)).toBe(1);
  });

  it("climbs above 1 at positive rep, max ~1.25 at REPUTATION_MAX", () => {
    expect(reputationPriceMultiplier(REPUTATION_MAX)).toBeCloseTo(1.25, 5);
    expect(reputationPriceMultiplier(REPUTATION_MAX / 2)).toBeGreaterThan(1);
    expect(reputationPriceMultiplier(REPUTATION_MAX / 2)).toBeLessThan(1.25);
  });

  it("drops below 1 at negative rep, min ~0.85 at REPUTATION_MIN", () => {
    expect(reputationPriceMultiplier(REPUTATION_MIN)).toBeCloseTo(0.85, 5);
    expect(reputationPriceMultiplier(REPUTATION_MIN / 2)).toBeLessThan(1);
    expect(reputationPriceMultiplier(REPUTATION_MIN / 2)).toBeGreaterThan(0.85);
  });

  it("is monotonic — more reputation never lowers the multiplier", () => {
    let prev = -Infinity;
    for (let r = REPUTATION_MIN; r <= REPUTATION_MAX; r++) {
      const m = reputationPriceMultiplier(r);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });
});
