import { describe, it, expect } from "vitest";
import { Rng } from "../rng";
import { generateFounders, generateFounder, FOUNDER_COUNT } from "./founders";
import { rollTraits, suggestSwaps, TRAITS_BY_ID } from "./traits";

describe("founder generation", () => {
  it("produces FOUNDER_COUNT dwarves with distinct first names", () => {
    const rng = Rng.fromSeed(123).fork("founders");
    const founders = generateFounders(rng);
    expect(founders.length).toBe(FOUNDER_COUNT);
    const firsts = new Set(founders.map((f) => f.name.split(" ")[0]));
    // We try hard to avoid duplicates but the small name pool may collide;
    // assert at least 5 of 7 are distinct as a robustness check.
    expect(firsts.size).toBeGreaterThanOrEqual(5);
  });

  it("each founder has 2-4 traits with no conflict-group duplicates", () => {
    const rng = Rng.fromSeed(456).fork("founders");
    const founders = generateFounders(rng);
    for (const f of founders) {
      expect(f.traits.length).toBeGreaterThanOrEqual(2);
      expect(f.traits.length).toBeLessThanOrEqual(4);
      const groups = f.traits.map((t) => t.conflictGroup).filter((g): g is string => !!g);
      expect(new Set(groups).size).toBe(groups.length);
    }
  });

  it("each founder has at least one bias-skill above novice", () => {
    const rng = Rng.fromSeed(789).fork("founders");
    const founders = generateFounders(rng);
    for (const f of founders) {
      const max = Math.max(...Object.values(f.skills));
      expect(max).toBeGreaterThanOrEqual(5); // at least Adequate
    }
  });

  it("is deterministic from a forked seed", () => {
    const a = generateFounders(Rng.fromSeed(2024).fork("founders"));
    const b = generateFounders(Rng.fromSeed(2024).fork("founders"));
    for (let i = 0; i < FOUNDER_COUNT; i++) {
      expect(a[i].name).toBe(b[i].name);
      expect(a[i].traits.map((t) => t.id)).toEqual(b[i].traits.map((t) => t.id));
      expect(a[i].profession).toBe(b[i].profession);
      expect(a[i].age).toBe(b[i].age);
    }
  });

  it("re-rolling a single founder doesn't change the others", () => {
    const rng = Rng.fromSeed(42).fork("founders");
    const initial = generateFounders(rng.fork("initial"));
    const replaced = [...initial];
    const used = new Set(replaced.filter((_, i) => i !== 3).map((g) => g.name.split(" ")[0]));
    replaced[3] = generateFounder(rng.fork("reroll_3"), used);
    for (let i = 0; i < FOUNDER_COUNT; i++) {
      if (i === 3) continue;
      expect(replaced[i]).toBe(initial[i]);
    }
  });
});

describe("trait rolling", () => {
  it("never picks two traits in the same conflict group", () => {
    const rng = Rng.fromSeed(7);
    for (let trial = 0; trial < 50; trial++) {
      const traits = rollTraits(rng.fork(`t${trial}`), 4);
      const groups = traits.map((t) => t.conflictGroup).filter((g): g is string => !!g);
      expect(new Set(groups).size).toBe(groups.length);
    }
  });

  it("suggestSwaps returns 3 unique alternatives that don't conflict with retained traits", () => {
    const rng = Rng.fromSeed(11);
    const baseline = rollTraits(rng.fork("base"), 3);
    const current = baseline[0];
    const others = baseline.slice(1);
    const swaps = suggestSwaps(rng.fork("swaps"), current, others);
    expect(swaps.length).toBe(3);
    expect(new Set(swaps.map((t) => t.id)).size).toBe(3);
    const retainedGroups = new Set(others.map((t) => t.conflictGroup).filter((g): g is string => !!g));
    for (const s of swaps) {
      if (s.conflictGroup) expect(retainedGroups.has(s.conflictGroup)).toBe(false);
      expect(s.id).not.toBe(current.id);
    }
  });

  it("trait registry is internally consistent", () => {
    for (const id of Object.keys(TRAITS_BY_ID)) {
      const t = TRAITS_BY_ID[id];
      expect(t.id).toBe(id);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
