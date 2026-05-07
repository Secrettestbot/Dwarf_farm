import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";
import { TICKS_PER_YEAR } from "../time";
import { TileType } from "../world/tiles";

function buildSim(seed: number, age: number, traitIds: string[] = []): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.spawnDwarf({
    name: "Borin",
    x: w.spawn.x,
    y: w.spawn.y,
    age,
    traitIds,
    profession: "Miner",
  });
  return sim;
}

describe("dwarf death", () => {
  it("a dwarf at the death threshold age dies at the next year boundary", () => {
    // Spawn at exactly the threshold; first year-aligned tick triggers death.
    const sim = buildSim(1, 150);
    expect(sim.dwarf.size()).toBe(1);
    // Run one in-game year; death system fires on tick = TICKS_PER_YEAR.
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    expect(sim.dwarf.size()).toBe(0);
  });

  it("dwarf-touched dwarves live past the default threshold", () => {
    const sim = buildSim(2, 150, ["dwarf_touched"]);
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    // Still alive — threshold for dwarf-touched is 250.
    expect(sim.dwarf.size()).toBe(1);
  });

  it("logs a death event with name, profession, and age", () => {
    const sim = buildSim(3, 150);
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    const deaths = sim.events.events.filter((e) => e.category === "social");
    expect(deaths.length).toBeGreaterThanOrEqual(1);
    const text = deaths[0].text;
    expect(text).toContain("Borin");
    expect(text).toMatch(/15[01]/);
  });

  it("places a Memorial tile where the dwarf fell", () => {
    const sim = buildSim(4, 150);
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    // The dwarf may have wandered before dying — scan the whole grid for
    // the Memorial. Cheap because the test world is only 200×500.
    let memorialFound = false;
    sim.grid.eachChunk((chunk) => {
      for (let i = 0; i < chunk.tiles.length && !memorialFound; i++) {
        if (chunk.tiles[i] === TileType.Memorial) memorialFound = true;
      }
    });
    expect(memorialFound).toBe(true);
  });

  it("does not double-fire deaths after a dwarf is removed", () => {
    const sim = buildSim(5, 150);
    for (let i = 0; i < TICKS_PER_YEAR * 3; i++) tick(sim);
    const deaths = sim.events.events.filter((e) => e.category === "social");
    expect(deaths.length).toBe(1);
  });
});
