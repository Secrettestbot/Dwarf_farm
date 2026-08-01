import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_DAY } from "./time";

describe("siege withdrawal", () => {
  it("an unbeatable warband withdraws after six days and counts as survived", () => {
    const w = generateWorld({ seed: 5501, width: 200, height: 500 });
    const sim = new SimWorld(5501, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D0", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(sim.dwarf.entities[0])!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    // Warband stuck on the surface, colony walled below.
    const gob = sim.spawnHostile({
      kind: "goblin_scout",
      x: w.spawn.x,
      y: sim.surfaceY[w.spawn.x],
      siegeMember: true,
    });
    sim.siegeActive = true;
    sim.siegeStartedAtTick = sim.tick;
    const survivedBefore = sim.siegesSurvived;
    // Jump to just before the withdrawal deadline, then cross it.
    sim.tick += TICKS_PER_DAY * 6 - 2;
    tick(sim);
    expect(sim.siegeActive).toBe(true);
    tick(sim);
    expect(sim.siegeActive).toBe(false);
    expect(sim.ecs.isAlive(gob)).toBe(false);
    expect(sim.siegesSurvived).toBe(survivedBefore + 1);
    expect(sim.events.events.some((e) => e.text.includes("breaks camp and withdraws"))).toBe(true);
  });
});
