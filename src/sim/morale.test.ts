import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { effectsFor } from "./dwarves/traitEffects";

describe("morale", () => {
  it("a default dwarf starts at the 50 baseline", () => {
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const sim = new SimWorld(71, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    expect(sim.needs.get(e)?.morale).toBe(50);
  });

  it("Cheerful raises the morale baseline; Melancholic lowers it", () => {
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    const sim = new SimWorld(73, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "C", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["cheerful"] });
    sim.spawnDwarf({ name: "M", x: w.spawn.x + 1, y: w.spawn.y, age: 30, traitIds: ["melancholic"] });
    const c = sim.dwarf.entities[0];
    const m = sim.dwarf.entities[1];
    expect(sim.needs.get(c)?.morale).toBe(60);
    expect(sim.needs.get(m)?.morale).toBe(40);
  });

  it("morale drifts down when needs are low", () => {
    const w = generateWorld({ seed: 75, width: 200, height: 500 });
    const sim = new SimWorld(75, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    n.sleep = 10; n.hunger = 10; n.thirst = 10; n.social = 10;
    n.morale = 60;
    // Pin needs each tick so they don't decay further (we want to isolate
    // the morale drift, not let starvation kill the dwarf).
    for (let i = 0; i < 60 * 6; i++) {
      n.sleep = 10; n.hunger = 10; n.thirst = 10; n.social = 10;
      tick(sim);
    }
    expect(sim.needs.get(e)!.morale).toBeLessThan(60);
  });

  it("Tough trait scales max HP up; Frail scales it down", () => {
    const w = generateWorld({ seed: 77, width: 200, height: 500 });
    const sim = new SimWorld(77, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "T", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["tough"] });
    sim.spawnDwarf({ name: "F", x: w.spawn.x + 1, y: w.spawn.y, age: 30, traitIds: ["frail"] });
    const t = sim.dwarf.entities[0];
    const f = sim.dwarf.entities[1];
    expect(sim.health.get(t)!.maxHp).toBeGreaterThan(100);
    expect(sim.health.get(f)!.maxHp).toBeLessThan(100);
  });

  it("effectsFor folds trait modifiers correctly", () => {
    expect(effectsFor([]).workSpeed).toBe(1);
    expect(effectsFor(["diligent"]).workSpeed).toBeCloseTo(1.15);
    expect(effectsFor(["lazy"]).workSpeed).toBeCloseTo(0.85);
    expect(effectsFor(["natural_miner"]).miningBonus).toBe(2);
    expect(effectsFor(["iron_constitution"]).needDecay).toBeCloseTo(1.3);
  });
});
