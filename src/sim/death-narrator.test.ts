import { describe, it, expect } from "vitest";
import { Rng } from "./rng";
import { narrateDeath } from "./events/narrator";

// The death narrator switches voice by cause. The cause strings are
// produced at the killDwarf call sites in sim.ts:
//   "old age", "starvation", "dehydration",
//   "slain by <article>" (hostile), "struck dead by <name>" (murder),
//   and the disease labels ("cave cough", "deep fever",
//   "wound sickness"). Each gets its own pool; anything unrecognised
//   falls through to the generic line.

describe("death narrator picks a voice per cause", () => {
  it("old age reads peacefully and never mentions violence", () => {
    const rng = Rng.fromSeed(11);
    for (let i = 0; i < 30; i++) {
      const line = narrateDeath(rng, "Urist", "Miner", 142, "old age");
      expect(line).toContain("Urist");
      expect(line).not.toMatch(/killed|slain|struck down|starved|thirst/);
    }
  });

  it("hostile death names the foe parsed from the cause", () => {
    const rng = Rng.fromSeed(12);
    for (let i = 0; i < 30; i++) {
      const line = narrateDeath(rng, "Urist", "Soldier", 40, "slain by a goblin scout");
      expect(line).toContain("a goblin scout");
      expect(line).toContain("Urist");
      // The raw "slain by <x>" template should be reworded, not echoed.
      expect(line).not.toContain("slain by a goblin scout");
    }
  });

  it("murder names the killer and frames it as a colony wound", () => {
    const rng = Rng.fromSeed(13);
    let mentionedKiller = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateDeath(rng, "Urist", "Brewer", 55, "struck dead by Kogan");
      expect(line).toContain("Kogan");
      if (line.includes("forget") || line.includes("their own") || line.includes("underground")) {
        mentionedKiller = true;
      }
    }
    expect(mentionedKiller).toBe(true);
  });

  it("disease deaths name the illness", () => {
    const rng = Rng.fromSeed(14);
    for (const illness of ["cave cough", "deep fever", "wound sickness"]) {
      for (let i = 0; i < 10; i++) {
        const line = narrateDeath(rng, "Urist", "Farmer", 60, illness);
        expect(line).toContain(illness);
        expect(line).toContain("Urist");
      }
    }
  });

  it("starvation and dehydration read as colony failures", () => {
    const rng = Rng.fromSeed(15);
    for (let i = 0; i < 20; i++) {
      const starve = narrateDeath(rng, "Urist", "Hauler", 33, "starvation");
      expect(starve).toMatch(/starv|hunger|meal/i);
      const thirst = narrateDeath(rng, "Doren", "Mason", 33, "dehydration");
      expect(thirst).toMatch(/thirst|dehydration|drink|wells/i);
    }
  });

  it("an unrecognised cause falls through to the generic line", () => {
    const rng = Rng.fromSeed(16);
    const line = narrateDeath(rng, "Urist", "Miner", 70, "a cave-in");
    expect(line).toBe("Urist, Miner, has died (a cave-in). Aged 70 years.");
  });

  it("is deterministic for the same seed and cause", () => {
    const a = narrateDeath(Rng.fromSeed(99), "Urist", "Miner", 50, "slain by a cave troll");
    const b = narrateDeath(Rng.fromSeed(99), "Urist", "Miner", 50, "slain by a cave troll");
    expect(a).toBe(b);
  });
});
