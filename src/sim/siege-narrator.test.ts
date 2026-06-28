import { describe, it, expect } from "vitest";
import { Rng } from "./rng";
import { narrateSiegeArrival } from "./events/narrator";

// The siege-arrival line must always carry the literal "siege begins"
// (the siege integration test keys off it) and should escalate its
// voice with the tier.

describe("siege arrival narrator", () => {
  it("always contains the 'siege begins' anchor the integration test relies on", () => {
    const rng = Rng.fromSeed(1);
    for (let tier = 1; tier <= 12; tier++) {
      const line = narrateSiegeArrival(rng, {
        goblinCount: 8,
        championCount: tier >= 3 ? 2 : 0,
        trollCount: tier >= 5 ? 2 : 0,
        warlordName: tier >= 2 ? "Drogmar the Cleaver" : "",
        tier,
      });
      expect(line).toContain("siege begins");
      expect(line).toContain("8 goblins");
    }
  });

  it("names the warlord when one leads", () => {
    const line = narrateSiegeArrival(Rng.fromSeed(2), {
      goblinCount: 10,
      championCount: 0,
      trollCount: 0,
      warlordName: "Skarn Iron-Jaw",
      tier: 2,
    });
    expect(line).toContain("led by Skarn Iron-Jaw");
  });

  it("mentions the trolls/champions backing a warlord-led host", () => {
    const line = narrateSiegeArrival(Rng.fromSeed(3), {
      goblinCount: 14,
      championCount: 2,
      trollCount: 1,
      warlordName: "Vurok the Pale",
      tier: 6,
    });
    expect(line).toContain("Vurok the Pale");
    expect(line).toMatch(/champion/);
    expect(line).toMatch(/cave troll/);
  });

  it("falls back to a troll/champion leader clause when there's no warlord", () => {
    const trollLed = narrateSiegeArrival(Rng.fromSeed(4), {
      goblinCount: 9,
      championCount: 0,
      trollCount: 2,
      warlordName: "",
      tier: 3,
    });
    expect(trollLed).toContain("cave trolls at their head");

    const championLed = narrateSiegeArrival(Rng.fromSeed(5), {
      goblinCount: 9,
      championCount: 2,
      trollCount: 0,
      warlordName: "",
      tier: 3,
    });
    expect(championLed).toContain("champions among them");
  });

  it("a high-tier host reads as bigger than a first siege", () => {
    const first = narrateSiegeArrival(Rng.fromSeed(6), {
      goblinCount: 7,
      championCount: 0,
      trollCount: 0,
      warlordName: "",
      tier: 1,
    });
    expect(first).toContain("as a warband");

    const rng = Rng.fromSeed(7);
    let sawGreatHost = false;
    let sawTierTail = false;
    for (let i = 0; i < 20; i++) {
      const late = narrateSiegeArrival(rng, {
        goblinCount: 24,
        championCount: 3,
        trollCount: 3,
        warlordName: "Ghazak Bone-Drinker",
        tier: 7,
      });
      if (late.includes("great host")) sawGreatHost = true;
      if (
        late.includes("largest host") ||
        late.includes("slopes are black") ||
        late.includes("not been a war-host")
      ) {
        sawTierTail = true;
      }
    }
    expect(sawGreatHost).toBe(true);
    expect(sawTierTail).toBe(true);
  });

  it("is deterministic for the same seed and context", () => {
    const ctx = { goblinCount: 12, championCount: 1, trollCount: 1, warlordName: "Murz", tier: 5 };
    expect(narrateSiegeArrival(Rng.fromSeed(99), ctx)).toBe(narrateSiegeArrival(Rng.fromSeed(99), ctx));
  });
});
