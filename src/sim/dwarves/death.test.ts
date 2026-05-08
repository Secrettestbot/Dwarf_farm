import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";
import { TICKS_PER_YEAR } from "../time";
import { TileType } from "../world/tiles";
import { EntityId } from "../ecs/world";

function buildSim(seed: number, age: number, traitIds: string[] = []): { sim: SimWorld; borin: EntityId } {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  const borin = sim.spawnDwarf({
    name: "Borin",
    x: w.spawn.x,
    y: w.spawn.y,
    age,
    traitIds,
    profession: "Miner",
  });
  return { sim, borin };
}

describe("dwarf death", () => {
  it("a dwarf at the death threshold age dies at the next year boundary", () => {
    // Spawn at exactly the threshold; first year-aligned tick triggers death.
    const { sim, borin } = buildSim(1, 150);
    expect(sim.ecs.isAlive(borin)).toBe(true);
    // Run one in-game year; death system fires on tick = TICKS_PER_YEAR.
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    // Migration may have brought in immigrants during the year — the
    // assertion is on the specific dwarf, not the population total.
    expect(sim.ecs.isAlive(borin)).toBe(false);
  });

  it("dwarf-touched dwarves live past the default threshold", () => {
    const { sim, borin } = buildSim(2, 150, ["dwarf_touched"]);
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    expect(sim.ecs.isAlive(borin)).toBe(true);
  });

  it("logs a death event with name, profession, and age", () => {
    const { sim } = buildSim(3, 150);
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    const deaths = sim.events.events.filter(
      (e) =>
        e.category === "social" &&
        e.text.includes("Borin") &&
        /died|dead|passed|did not wake/i.test(e.text),
    );
    expect(deaths.length).toBeGreaterThanOrEqual(1);
    expect(deaths[0].text).toMatch(/15[01]/);
  });

  it("places a Memorial tile where the dwarf fell", () => {
    const { sim } = buildSim(4, 150);
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) tick(sim);
    let memorialFound = false;
    sim.grid.eachChunk((chunk) => {
      for (let i = 0; i < chunk.tiles.length && !memorialFound; i++) {
        if (chunk.tiles[i] === TileType.Memorial) memorialFound = true;
      }
    });
    expect(memorialFound).toBe(true);
  });

  it("does not double-fire deaths after a dwarf is removed", () => {
    const { sim } = buildSim(5, 150);
    for (let i = 0; i < TICKS_PER_YEAR * 3; i++) tick(sim);
    // Filter to "Borin" death events specifically — the social category
    // also covers arrivals, births, pairings, recoveries, and bereavements.
    const borinDeaths = sim.events.events.filter(
      (e) =>
        e.category === "social" &&
        e.text.includes("Borin") &&
        /died|dead|passed|did not wake/i.test(e.text),
    );
    expect(borinDeaths.length).toBe(1);
  });
});
