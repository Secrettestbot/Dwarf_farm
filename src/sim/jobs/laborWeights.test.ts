import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";
import { categoryCap, categoryOpen, laborSnapshot, promotedCategories } from "./laborWeights";

function makeSim(seed: number, dwarves: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < dwarves; i++) {
    sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
  }
  return sim;
}

function pinNeeds(sim: SimWorld): void {
  for (const e of sim.dwarf.entities) {
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
  }
}

describe("slider labour weighting", () => {
  it("leaves categories uncapped and unpromoted at neutral", () => {
    const sim = makeSim(21, 10);
    for (const e of sim.dwarf.entities) expect(promotedCategories(sim, e)).toEqual([]);
    expect(categoryCap(sim, "excavation")).toBe(Infinity);
    expect(categoryOpen(sim, "excavation")).toBe(true);
  });

  it("caps a below-neutral category at a share of workers", () => {
    const sim = makeSim(22, 10);
    sim.sliders.excavation = 0.25; // half of neutral → half the workers
    expect(categoryCap(sim, "excavation")).toBe(5);
    sim.sliders.excavation = 0.02;
    expect(categoryCap(sim, "excavation")).toBe(0);
    expect(categoryOpen(sim, "excavation")).toBe(false);
  });

  it("promotes a growing share of workers as a slider rises", () => {
    const sim = makeSim(23, 40);
    const promotedShare = (v: number) => {
      sim.sliders.research = v;
      let n = 0;
      for (const e of sim.dwarf.entities) if (promotedCategories(sim, e).includes("research")) n++;
      return n / sim.dwarf.size();
    };
    const mid = promotedShare(0.75);
    expect(promotedShare(0.5)).toBe(0);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    expect(promotedShare(1)).toBe(1);
  });

  it("a low excavation slider keeps most of the colony off the mining face", () => {
    const run = (excavation: number) => {
      const sim = makeSim(13, 8);
      sim.sliders.excavation = excavation;
      let peak = 0;
      for (let i = 0; i < 600; i++) {
        pinNeeds(sim);
        tick(sim);
        peak = Math.max(peak, laborSnapshot(sim).counts.excavation);
      }
      return peak;
    };
    const low = run(0.1);
    // 0.1 → cap of ceil(8 × 0.2) = 2 miners.
    expect(low).toBeLessThanOrEqual(2);
    expect(low).toBeGreaterThan(0);
  });
});
