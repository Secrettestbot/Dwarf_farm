import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { findMineTarget } from "./jobs/chooseJob";
import { snapshot, restore } from "../save/snapshot";

function makeSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  return new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
}

function pin(sim: SimWorld): void {
  for (const e of sim.dwarf.entities) {
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
  }
}

describe("player zones", () => {
  it("dwarves excavate rock inside a Dig Zone", () => {
    const sim = makeSim(81);
    const { x, y } = sim.spawn;
    // A block of solid rock just below the founders' hall.
    const zx = x - 2, zy = y + 3;
    for (let yy = zy; yy < zy + 2; yy++) for (let xx = zx; xx < zx + 4; xx++) sim.grid.setTile(xx, yy, TileType.Stone);
    for (let yy = y + 1; yy < zy; yy++) sim.grid.setTile(x, yy, TileType.CorridorFloor);
    sim.regions.invalidate();
    sim.zones.add("dig", zx, zy, zx + 3, zy + 1);
    expect(findMineTarget(sim, x, y)).not.toBeNull();
    sim.spawnDwarf({ name: "Digger", x, y, age: 30 });
    sim.spawnDwarf({ name: "Delver", x, y, age: 30 });
    let mined = 0;
    for (let i = 0; i < 3000; i++) {
      pin(sim);
      tick(sim);
      mined = 0;
      for (let yy = zy; yy < zy + 2; yy++) for (let xx = zx; xx < zx + 4; xx++) if (!sim.grid.isSolid(xx, yy)) mined++;
      if (mined === 8) break;
    }
    expect(mined).toBeGreaterThan(0);
  });

  it("A* routes around a Forbidden Zone and won't end inside one", () => {
    const sim = makeSim(83);
    const y = 300;
    for (let x = 20; x <= 40; x++) for (let dy = -1; dy <= 1; dy++) sim.grid.setTile(x, y + dy, TileType.CorridorFloor);
    sim.regions.invalidate();
    expect(sim.astar.findPath(sim.grid, 20, y, 40, y)).not.toBeNull();
    // Wall off the full corridor height.
    sim.zones.add("forbidden", 30, y - 1, 30, y + 1);
    expect(sim.astar.findPath(sim.grid, 20, y, 40, y)).toBeNull();
    expect(sim.astar.findPath(sim.grid, 20, y, 30, y)).toBeNull();
    // A dwarf already inside may still leave.
    expect(sim.astar.findPath(sim.grid, 30, y, 20, y)).not.toBeNull();
    sim.zones.removeAt(30, y);
    expect(sim.astar.findPath(sim.grid, 20, y, 40, y)).not.toBeNull();
  });

  it("zones survive a save round-trip", () => {
    const sim = makeSim(85);
    sim.zones.add("gather", 10, 10, 12, 14);
    sim.zones.add("forbidden", 50, 60, 40, 55);
    const save = snapshot({ sim, slotId: "slot0", fortressName: "Z", mode: "legacy", cameraX: 0, cameraY: 0, zoomIndex: 1 });
    const back = restore(save);
    expect(back.zones.zones.map((z) => [z.kind, z.x0, z.y0, z.x1, z.y1])).toEqual([
      ["gather", 10, 10, 12, 14],
      ["forbidden", 40, 55, 50, 60],
    ]);
    expect(back.zones.isForbidden(45, 58)).toBe(true);
    expect(back.astar.zoneMask).toBe(back.zones.mask);
  });
});
