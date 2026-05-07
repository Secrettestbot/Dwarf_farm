import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { TileType } from "../world/tiles";
import { Rng } from "../rng";
import { ColonyPlanner } from "./colonyPlanner";

describe("placeMine", () => {
  it("emits a mine when ore is planted right outside the spawn cavern", () => {
    const w = generateWorld({ seed: 1, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(1);
    // The spawn cavern is 13 tiles wide centered on spawn.x. One tile
    // outside that on the right is naturally solid Dirt — overwrite that
    // single tile with Ore to simulate a vein the colony has just exposed.
    const ox = w.spawn.x + 7;
    const oy = w.spawn.y + 1;
    expect(w.grid.isSolid(ox, oy)).toBe(true);
    w.grid.setTile(ox, oy, TileType.Ore);

    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 7, rng });
    }
    expect(planner.blueprints.some((b) => b.kind === "mine")).toBe(true);
  });
});
