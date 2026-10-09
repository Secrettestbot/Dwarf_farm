import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { wadeStep } from "./systems/stranded";

describe("stranded dwarves", () => {
  it("a dwarf whose tile floods wades back to dry floor", () => {
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const sim = new SimWorld(71, w.grid, w.surfaceY, w.spawn);
    const { x, y } = sim.spawn;
    // A short flooded strip with the dwarf at its far end.
    for (let dx = 0; dx <= 3; dx++) sim.grid.setTile(x + dx, y, TileType.CorridorFloor);
    sim.grid.setTile(x + 1, y, TileType.Water);
    sim.grid.setTile(x + 2, y, TileType.Water);
    sim.grid.setTile(x + 3, y, TileType.Water);
    sim.regions.invalidate();
    const e = sim.spawnDwarf({ name: "Wet", x: x + 3, y, age: 30 });
    expect(wadeStep(sim, x + 3, y)).not.toBeNull();
    for (let i = 0; i < 10; i++) tick(sim);
    const p = sim.position.get(e)!;
    expect(sim.grid.isWalkable(p.x, p.y)).toBe(true);
  });

  it("returns null when no dry floor is in range", () => {
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    const sim = new SimWorld(73, w.grid, w.surfaceY, w.spawn);
    const cx = 100, cy = 300;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sim.grid.setTile(cx + dx, cy + dy, TileType.Stone);
    sim.grid.setTile(cx, cy, TileType.Water);
    expect(wadeStep(sim, cx, cy)).toBeNull();
  });
});
