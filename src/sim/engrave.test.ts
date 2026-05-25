import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint, QUALITY_BASE } from "./planner/blueprint";

/** Plant a complete dining hall blueprint near spawn so the
 * engraving system has somewhere to work. Returns the blueprint
 * so tests can inspect quality + decorationsCount. */
function plantDiningHall(sim: SimWorld): Blueprint {
  const ox = sim.spawn.x + 1;
  const oy = sim.spawn.y;
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 4; xx++) {
      cavity.push((yy << 16) | xx);
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  const bp: Blueprint = {
    id: 9300,
    kind: "dining_hall",
    originX: ox,
    originY: oy,
    width: 4,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
    quality: QUALITY_BASE,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("engraving system", () => {
  it("a dwarf engraves a complete room when blocks are available, raising quality", () => {
    const w = generateWorld({ seed: 821, width: 200, height: 500 });
    const sim = new SimWorld(821, w.grid, w.surfaceY, w.spawn);
    const room = plantDiningHall(sim);
    sim.stockpile.blocks = 5;
    // Suppress excavation / haul so the dwarf focuses on engraving.
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.spawnDwarf({ name: "Artist", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    const id = sim.dwarf.entities[0];
    const qualityBefore = room.quality ?? 0;
    for (let i = 0; i < 800; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if ((room.decorationsCount ?? 0) >= 1) break;
    }
    expect(room.decorationsCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(room.quality ?? 0).toBeGreaterThan(qualityBefore);
    expect(sim.stockpile.blocks).toBe(4); // one consumed
  });

  it("cut gems give a bigger quality bump than blocks", () => {
    const w = generateWorld({ seed: 823, width: 200, height: 500 });
    const sim = new SimWorld(823, w.grid, w.surfaceY, w.spawn);
    const room = plantDiningHall(sim);
    // Stocked with cut_gems but no blocks — engraver must use the gem.
    sim.stockpile.cut_gems = 5;
    sim.stockpile.blocks = 0;
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.spawnDwarf({ name: "Jeweller", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    const id = sim.dwarf.entities[0];
    const qualityBefore = room.quality ?? 0;
    for (let i = 0; i < 800; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if ((room.decorationsCount ?? 0) >= 1) break;
    }
    const gemBump = (room.quality ?? 0) - qualityBefore;
    // ENGRAVE_QUALITY_PER_GEM = 12, vs ENGRAVE_QUALITY_PER_BLOCK = 5.
    // Allow ≥ 10 as the assertion to tolerate small future tweaks.
    expect(gemBump).toBeGreaterThanOrEqual(10);
    expect(sim.stockpile.cut_gems).toBe(4);
  });

  it("engraving stops once the room hits its decoration cap", () => {
    const w = generateWorld({ seed: 825, width: 200, height: 500 });
    const sim = new SimWorld(825, w.grid, w.surfaceY, w.spawn);
    const room = plantDiningHall(sim); // 12-tile cavity → cap = 3
    sim.stockpile.blocks = 100;
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.spawnDwarf({ name: "A", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    sim.spawnDwarf({ name: "B", x: sim.spawn.x + 1, y: sim.spawn.y, age: 30 });
    for (let i = 0; i < 4000; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    // Cap = ceil(12 / 4) = 3. The room never accumulates more.
    expect(room.decorationsCount ?? 0).toBeLessThanOrEqual(3);
    expect(room.decorationsCount ?? 0).toBeGreaterThan(0);
  });
});
