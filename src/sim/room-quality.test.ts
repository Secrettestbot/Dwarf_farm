import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint, QUALITY_BASE, QUALITY_MAX } from "./planner/blueprint";

function plantBedroom(sim: SimWorld, ox: number, oy: number, w: number, h: number, lastMaintainedTick = 0): Blueprint {
  const cavity = new Int32Array(w * h);
  let i = 0;
  for (let yy = oy; yy < oy + h; yy++) {
    for (let xx = ox; xx < ox + w; xx++) {
      cavity[i++] = (yy << 16) | xx;
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  const bp: Blueprint = {
    id: 7000 + sim.planner.blueprints.length,
    kind: "bedroom",
    originX: ox,
    originY: oy,
    width: w,
    height: h,
    cavity,
    status: "complete",
    priority: 1,
    createdTick: 0,
    lastMaintainedTick,
    quality: QUALITY_BASE,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("room quality (GDD §7.3)", () => {
  it("a maintain pass raises room quality by QUALITY_PER_MAINTAIN", () => {
    const w = generateWorld({ seed: 921, width: 200, height: 500 });
    const sim = new SimWorld(921, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    // Pin needs so the dwarf focuses on maintenance.
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    // Plant a neglected bedroom. The dwarf will go maintain it.
    const bp = plantBedroom(sim, w.spawn.x + 2, w.spawn.y, 3, 2, -1_000_000);
    const before = bp.quality ?? QUALITY_BASE;
    for (let i = 0; i < 200; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(bp.quality ?? 0).toBeGreaterThan(before);
  });

  it("quality saturates at QUALITY_MAX even after many maintains", () => {
    const w = generateWorld({ seed: 923, width: 200, height: 500 });
    const sim = new SimWorld(923, w.grid, w.surfaceY, w.spawn);
    const bp = plantBedroom(sim, w.spawn.x + 2, w.spawn.y, 3, 2, 0);
    bp.quality = QUALITY_MAX;
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Force a long stretch with maintenance happening.
    const e = sim.dwarf.entities[0];
    bp.lastMaintainedTick = -1_000_000; // mark neglected so the dwarf maintains
    for (let i = 0; i < 600; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(bp.quality).toBeLessThanOrEqual(QUALITY_MAX);
  });

  it("sleeping in a high-quality bedroom gives a morale bump on wake", () => {
    const w = generateWorld({ seed: 925, width: 200, height: 500 });
    const sim = new SimWorld(925, w.grid, w.surfaceY, w.spawn);
    // Plant a high-quality bedroom with a Bed tile. Dwarf sleeps,
    // morale rises beyond the baseline drift.
    const bp = plantBedroom(sim, w.spawn.x + 2, w.spawn.y, 3, 2, 0);
    bp.quality = QUALITY_MAX;
    sim.grid.setTile(w.spawn.x + 2, w.spawn.y, TileType.Bed);
    // Carve corridor.
    sim.grid.setTile(w.spawn.x + 1, w.spawn.y, TileType.CorridorFloor);
    sim.spawnDwarf({ name: "Sleeper", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    // Drive the dwarf into a sleep cycle by setting sleep low.
    const needs = sim.needs.get(e)!;
    needs.sleep = 10;
    needs.morale = 50;
    needs.hunger = 100; needs.thirst = 100; needs.social = 100;
    const moraleBefore = needs.morale;
    for (let i = 0; i < 600; i++) {
      // Pin survival needs while the morale change is what we measure.
      needs.hunger = 100; needs.thirst = 100; needs.social = 100;
      tick(sim);
    }
    expect(needs.morale).toBeGreaterThan(moraleBefore);
  });
});
