import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { tileIsGem } from "./world/tiles";

describe("gem seam content", () => {
  it("worldgen places gems somewhere in the Gem Seam band (700-1200)", () => {
    const w = generateWorld({ seed: 121, width: 200, height: 1500 });
    let gems = 0;
    for (let y = 700; y < 1200; y++) {
      for (let x = 0; x < 200; x++) {
        if (tileIsGem(w.grid.getTile(x, y))) gems++;
      }
    }
    expect(gems).toBeGreaterThan(0);
  });

  it("mining a raw gem tile drops a gem item", () => {
    const w = generateWorld({ seed: 123, width: 200, height: 500 });
    const sim = new SimWorld(123, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.grid.setTile(sx + 1, sy, TileType.RawDiamond);
    sim.planner.blueprints.push({
      id: 1,
      kind: "mine",
      originX: sx + 1,
      originY: sy,
      width: 1,
      height: 1,
      cavity: new Int32Array([(sy << 16) | (sx + 1)]),
      status: "digging",
      priority: 1,
      createdTick: 0,
    });
    sim.sliders.hauling = 0; // pin so we can verify the drop on the floor
    sim.spawnDwarf({ name: "Borin", x: sx, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    let mined = false;
    for (let i = 0; i < 200 && !mined; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      mined = !sim.grid.isSolid(sx + 1, sy);
    }
    expect(mined).toBe(true);
    let gemFound = false;
    for (const ie of sim.item.entities) {
      const it = sim.item.get(ie);
      if (it?.kind === "gem") gemFound = true;
    }
    expect(gemFound).toBe(true);
  });
});
