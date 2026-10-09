import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_DAY } from "./time";
import { TileType } from "./world/tiles";

function colony(seed: number, n: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < n; i++) sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
  return sim;
}

function pin(sim: SimWorld): void {
  for (const e of sim.dwarf.entities) {
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
  }
}

describe("siege muster", () => {
  it("an announced siege calls up and arms soldiers without waiting for year's end", () => {
    const sim = colony(911, 10);
    sim.stockpile.tools = 5;
    sim.siegeScheduledTick = sim.tick + TICKS_PER_DAY * 5;
    pin(sim);
    tick(sim);
    expect(sim.squad.size()).toBe(1);
    expect(sim.equipment.get(sim.squad.entities[0])?.weapon).toBe(true);
    expect(sim.events.events.some((e) => /The colony musters/.test(e.text))).toBe(true);
  });

  it("raising the Military slider mid-siege calls up more soldiers at the next daily muster", () => {
    const sim = colony(913, 10);
    sim.siegeScheduledTick = sim.tick + TICKS_PER_DAY * 5;
    pin(sim);
    tick(sim);
    expect(sim.squad.size()).toBe(1);
    sim.sliders.military = 1;
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      pin(sim);
      tick(sim);
    }
    expect(sim.squad.size()).toBe(3);
  });

  it("soldiers ignore hostiles they can't reach (e.g. outside sealed gates)", () => {
    const sim = colony(915, 1);
    const id = sim.dwarf.entities[0];
    sim.squad.set(id, { draftedAtTick: 0 });
    pin(sim);
    const { x, y } = sim.spawn;
    // A rat in a sealed-off pocket three tiles away.
    for (let dx = 2; dx <= 4; dx++) for (let dy = -1; dy <= 1; dy++) sim.grid.setTile(x + dx, y + dy, TileType.Stone);
    sim.grid.setTile(x + 3, y, TileType.CorridorFloor);
    sim.regions.invalidate();
    sim.spawnHostile({ kind: "cave_rat", x: x + 3, y });
    tick(sim);
    expect(sim.job.get(id)?.kind).not.toBe("engage");
  });
});
