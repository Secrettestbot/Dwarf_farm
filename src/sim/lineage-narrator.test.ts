import { describe, it, expect } from "vitest";
import { Rng } from "./rng";
import { narratePairing, narrateBirth } from "./events/narrator";

// Pairing + birth narrators take an optional context object that
// picks a distinct voice for re-pairings (widowed dwarves bonding),
// first-colony-children, and Three-Generations births. With no
// context they still produce the original first-bond / generic-birth
// pools, which is what the catch-up worker generates for older
// chronicles built before this code shipped.

describe("pairing narrator marks re-pairings differently from first bonds", () => {
  it("default pool fires when neither side is widowed", () => {
    const rng = Rng.fromSeed(401);
    for (let i = 0; i < 30; i++) {
      const line = narratePairing(rng, "Urist", "Kogan");
      expect(line).toContain("Urist");
      expect(line).toContain("Kogan");
      // Default pool never references a previous partner or grief.
      expect(line).not.toMatch(/buried|mourned|grief|memory|solitudes/);
    }
  });

  it("a one-sided re-pairing names the lost partner", () => {
    const rng = Rng.fromSeed(402);
    let foundReference = false;
    for (let i = 0; i < 30; i++) {
      const line = narratePairing(rng, "Urist", "Kogan", { aLostPartnerName: "Doren" });
      // Every line in the one-sided pool references the deceased.
      expect(line).toContain("Doren");
      if (line.includes("once mourned") || line.includes("would not have begrudged") || line.includes("memory")) {
        foundReference = true;
      }
    }
    expect(foundReference).toBe(true);
  });

  it("both-widowed pool reads as a meeting of solitudes", () => {
    const rng = Rng.fromSeed(403);
    let foundBothPool = false;
    for (let i = 0; i < 30; i++) {
      const line = narratePairing(rng, "Urist", "Kogan", {
        aLostPartnerName: "Doren",
        bLostPartnerName: "Marda",
      });
      if (
        line.includes("both of whom buried partners") ||
        line.includes("Grief found grief") ||
        line.includes("two solitudes")
      ) {
        foundBothPool = true;
      }
    }
    expect(foundBothPool).toBe(true);
  });
});

describe("birth narrator marks colony milestones", () => {
  it("default pool fires for a routine birth", () => {
    const rng = Rng.fromSeed(501);
    for (let i = 0; i < 30; i++) {
      const line = narrateBirth(rng, "Tilda", "Urist", "Kogan");
      expect(line).toContain("Tilda");
      // Default pool doesn't claim "first" or "third generation".
      expect(line).not.toMatch(/first|generation|native/);
    }
  });

  it("first-colony-child pool fires when the flag is set", () => {
    const rng = Rng.fromSeed(502);
    let foundFirstMarker = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateBirth(rng, "Tilda", "Urist", "Kogan", { isFirstColonyChild: true });
      if (
        line.includes("first child born") ||
        line.includes("first native") ||
        line.includes("only its founders")
      ) {
        foundFirstMarker = true;
      }
    }
    expect(foundFirstMarker).toBe(true);
  });

  it("three-generations pool fires when both parents were colony-born", () => {
    const rng = Rng.fromSeed(503);
    let foundGenMarker = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateBirth(rng, "Tilda", "Urist", "Kogan", { bothParentsBornInColony: true });
      if (
        line.includes("third generation") ||
        line.includes("Three generations") ||
        line.includes("never saw the surface")
      ) {
        foundGenMarker = true;
      }
    }
    expect(foundGenMarker).toBe(true);
  });

  it("first-colony-child outranks both-parents-born when both are set", () => {
    const rng = Rng.fromSeed(504);
    for (let i = 0; i < 20; i++) {
      const line = narrateBirth(rng, "Tilda", "Urist", "Kogan", {
        isFirstColonyChild: true,
        bothParentsBornInColony: true,
      });
      // First-colony pool never mentions "third generation" or
      // "Three generations"; if both flags fire, the first-colony
      // wins.
      expect(line).not.toMatch(/third generation|Three generations|never saw the surface/);
    }
  });

  it("is deterministic for the same seed and context", () => {
    const a = narrateBirth(Rng.fromSeed(7), "Tilda", "Urist", "Kogan", { isFirstColonyChild: true });
    const b = narrateBirth(Rng.fromSeed(7), "Tilda", "Urist", "Kogan", { isFirstColonyChild: true });
    expect(a).toBe(b);
  });
});
