import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { Rng } from "./rng";
import { ColonyPlanner } from "./planner/colonyPlanner";

describe("research gates", () => {
  it("the smelter does not emit until Iron Smelting is researched", () => {
    const w = generateWorld({ seed: 301, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(2024);
    // Hand-excavate everything the planner emits so the architect can
    // keep ticking through.
    for (let t = 1; t <= 4000; t++) {
      planner.tick({
        grid: w.grid,
        spawn: w.spawn,
        tick: t,
        population: 12,
        rng,
        research: { completed: [] },
      });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          w.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, 7);
        }
      }
    }
    expect(planner.completedByKind["smelter"] ?? 0).toBe(0);
  });

  it("the smelter eventually emits once Iron Smelting is in the completed list", () => {
    const w = generateWorld({ seed: 303, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(2024);
    let emitted = false;
    for (let t = 1; t <= 4000 && !emitted; t++) {
      planner.tick({
        grid: w.grid,
        spawn: w.spawn,
        tick: t,
        population: 12,
        rng,
        research: { completed: ["iron_smelting"] },
      });
      for (const bp of planner.blueprints) {
        if (bp.kind === "smelter") emitted = true;
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          w.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, 7);
        }
      }
    }
    expect(emitted).toBe(true);
  });
});

describe("stairwells", () => {
  it("the architect emits stairwells as the colony grows", () => {
    const w = generateWorld({ seed: 305, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(2024);
    for (let t = 1; t <= 4000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 14, rng });
      for (const bp of planner.blueprints) {
        if (bp.status === "complete") {
          // Pin maintenance so neglect doesn't thrash the architect's targets.
          bp.lastMaintainedTick = t;
        }
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          w.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, 7);
        }
      }
    }
    // After enough rooms, at least one stairwell should have landed.
    expect((planner.completedByKind["stairwell"] ?? 0) +
           (planner.activeByKind()["stairwell"] ?? 0)).toBeGreaterThan(0);
  });
});
