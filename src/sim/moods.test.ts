import { describe, it, expect } from "vitest";
import { Rng } from "./rng";
import { narrateTantrumOnset, narrateObsessionOnset } from "./events/narrator";

// Tests for the in-character tantrum / obsession narrator. These
// exercise the narrator pure functions directly — wiring into the
// systems is straightforward enough that walking it end-to-end in a
// sim integration test would mostly retest the existing tantrum /
// obsession trigger logic. Pulling the narrator out behind a small
// interface (ctx) lets us verify each variant pool fires for the
// signal it's meant to.

describe("tantrum narrator names the cause", () => {
  it("picks a bereavement line when the dwarf has a deceased partner", () => {
    const rng = Rng.fromSeed(101);
    // 20 rolls — every line should mention the partner's name.
    for (let i = 0; i < 20; i++) {
      const line = narrateTantrumOnset(rng, "Urist", { lostPartnerName: "Doren" });
      expect(line).toContain("Doren");
      expect(line).toContain("Urist");
    }
  });

  it("picks a rivalry line when there's a feud but no lost partner", () => {
    const rng = Rng.fromSeed(102);
    for (let i = 0; i < 20; i++) {
      const line = narrateTantrumOnset(rng, "Urist", { rivalName: "Kogan" });
      expect(line).toContain("Kogan");
      expect(line).toContain("Urist");
    }
  });

  it("falls back to a generic line when nothing in context is set", () => {
    const rng = Rng.fromSeed(103);
    for (let i = 0; i < 20; i++) {
      const line = narrateTantrumOnset(rng, "Urist", {});
      expect(line.startsWith("Urist has broken.")).toBe(true);
      // Generic pool doesn't name a partner or rival.
      expect(line).not.toContain("Doren");
      expect(line).not.toContain("Kogan");
    }
  });

  it("bereavement outranks rivalry when both are set", () => {
    const rng = Rng.fromSeed(104);
    for (let i = 0; i < 20; i++) {
      const line = narrateTantrumOnset(rng, "Urist", {
        lostPartnerName: "Doren",
        rivalName: "Kogan",
      });
      expect(line).toContain("Doren");
      expect(line).not.toContain("Kogan");
    }
  });

  it("recently-wounded line fires when nothing more specific is set", () => {
    const rng = Rng.fromSeed(105);
    let foundWoundLine = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateTantrumOnset(rng, "Urist", { recentlyWounded: true });
      if (line.includes("wounds") || line.includes("hospital cot")) foundWoundLine = true;
    }
    expect(foundWoundLine).toBe(true);
  });
});

describe("obsession narrator distinguishes mastery from new craft", () => {
  it("uses the mastery pool when the fixation matches the dwarf's best skill", () => {
    const rng = Rng.fromSeed(201);
    let foundMasteryMarker = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateObsessionOnset(rng, "Urist", "smithing", {
        bestSkillId: "smithing",
        skillLabel: "Smithing",
      });
      // Mastery pool has a "retreated into" / "consumes them" / "will not leave
      // the workshop" framing distinct from the new-craft pool.
      if (
        line.includes("retreated into") ||
        line.includes("consumes them") ||
        line.includes("will not leave the workshop")
      ) {
        foundMasteryMarker = true;
      }
      expect(line).toContain("Smithing");
    }
    expect(foundMasteryMarker).toBe(true);
  });

  it("uses the new-craft pool when the fixation lands on a different skill", () => {
    const rng = Rng.fromSeed(202);
    let foundNewCraftMarker = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateObsessionOnset(rng, "Urist", "scholarship", {
        bestSkillId: "smithing",
        skillLabel: "Scholarship",
      });
      if (
        line.includes("master Scholarship") ||
        line.includes("not to be reasoned with") ||
        line.includes("glint in their eye")
      ) {
        foundNewCraftMarker = true;
      }
      expect(line).toContain("Scholarship");
    }
    expect(foundNewCraftMarker).toBe(true);
  });

  it("is deterministic for the same seed", () => {
    const r1 = Rng.fromSeed(303);
    const r2 = Rng.fromSeed(303);
    const ctx = { skillLabel: "Brewing", bestSkillId: undefined };
    expect(narrateObsessionOnset(r1, "Urist", "brewing", ctx)).toBe(
      narrateObsessionOnset(r2, "Urist", "brewing", ctx),
    );
  });
});
