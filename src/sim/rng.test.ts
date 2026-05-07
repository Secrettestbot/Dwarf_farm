import { describe, it, expect } from "vitest";
import { Rng } from "./rng";

describe("Rng (PCG32)", () => {
  it("produces the same sequence from the same seed", () => {
    const a = Rng.fromSeed(42);
    const b = Rng.fromSeed(42);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("produces different sequences from different seeds", () => {
    const a = Rng.fromSeed(1);
    const b = Rng.fromSeed(2);
    let identical = 0;
    for (let i = 0; i < 100; i++) {
      if (a.next() === b.next()) identical++;
    }
    expect(identical).toBeLessThan(5);
  });

  it("nextFloat is in [0, 1)", () => {
    const r = Rng.fromSeed(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.nextFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextRange honors bounds", () => {
    const r = Rng.fromSeed(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.nextRange(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("survives a serialize/deserialize round-trip mid-sequence", () => {
    const a = Rng.fromSeed(123);
    for (let i = 0; i < 500; i++) a.next();
    const snapshot = a.serialize();
    const expected = [a.next(), a.next(), a.next()];
    const b = Rng.deserialize(snapshot);
    expect([b.next(), b.next(), b.next()]).toEqual(expected);
  });

  it("forked streams are independent and deterministic", () => {
    const root1 = Rng.fromSeed(5);
    const root2 = Rng.fromSeed(5);
    const a1 = root1.fork("worldgen");
    const b1 = root1.fork("ai");
    const a2 = root2.fork("worldgen");
    const b2 = root2.fork("ai");

    // Same fork from same root reproduces.
    for (let i = 0; i < 100; i++) {
      expect(a1.next()).toBe(a2.next());
      expect(b1.next()).toBe(b2.next());
    }

    // Different labels produce different streams.
    const c1 = Rng.fromSeed(5).fork("worldgen");
    const c2 = Rng.fromSeed(5).fork("ai");
    let identical = 0;
    for (let i = 0; i < 100; i++) {
      if (c1.next() === c2.next()) identical++;
    }
    expect(identical).toBeLessThan(5);
  });
});
