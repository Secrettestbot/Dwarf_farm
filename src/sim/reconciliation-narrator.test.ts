import { describe, it, expect } from "vitest";
import { Rng } from "./rng";
import { narrateReconciliation } from "./events/narrator";

// The reconciliation line scales with how high the grudge climbed
// before it was buried (peak), mirroring the argument-escalation
// thresholds: >= 6 reads as a deep feud ending, >= 3 as a settled
// dispute, else a minor patched quarrel.

describe("reconciliation narrator scales with the buried feud's peak", () => {
  it("a deep feud (peak >= 6) ends with weight", () => {
    const rng = Rng.fromSeed(601);
    let deepMarker = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateReconciliation(rng, "Urist", "Kogan", 8);
      expect(line).toContain("Urist");
      expect(line).toContain("Kogan");
      if (
        line.includes("enemies for as long") ||
        line.includes("feud between") ||
        line.includes("years-deep grudge")
      ) {
        deepMarker = true;
      }
    }
    expect(deepMarker).toBe(true);
  });

  it("a moderate grudge (peak 3-5) reads as a settled dispute", () => {
    const rng = Rng.fromSeed(602);
    let midMarker = false;
    for (let i = 0; i < 30; i++) {
      const line = narrateReconciliation(rng, "Urist", "Kogan", 4);
      if (line.includes("made their peace") || line.includes("talk it out")) midMarker = true;
      // Should not reach for the deep-feud language.
      expect(line).not.toContain("years-deep");
    }
    expect(midMarker).toBe(true);
  });

  it("a minor spat (peak < 3) is a small patched quarrel", () => {
    const rng = Rng.fromSeed(603);
    for (let i = 0; i < 30; i++) {
      const line = narrateReconciliation(rng, "Urist", "Kogan", 1);
      expect(line).toMatch(/patch up their quarrel|let a small grievance go/);
    }
  });

  it("is deterministic for the same seed and peak", () => {
    const a = narrateReconciliation(Rng.fromSeed(9), "Urist", "Kogan", 7);
    const b = narrateReconciliation(Rng.fromSeed(9), "Urist", "Kogan", 7);
    expect(a).toBe(b);
  });
});
