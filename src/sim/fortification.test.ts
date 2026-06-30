import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { TICKS_PER_DAY } from "./time";

function feedAll(sim: SimWorld): void {
  for (const id of sim.dwarf.entities) {
    const n = sim.needs.get(id);
    if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; n.morale = 80; }
  }
}

describe("fortification ramparts", () => {
  it("the architect plans a rampart with a gate at the entrance once raid-worthy", () => {
    const w = generateWorld({ seed: 911, width: 200, height: 500 });
    const sim = new SimWorld(911, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 12; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    // Run a few days so the day-boundary planning roll fires.
    for (let i = 0; i < TICKS_PER_DAY * 3 && sim.fortificationPlan.length === 0; i++) {
      feedAll(sim);
      tick(sim);
    }
    expect(sim.fortificationPlan.length).toBeGreaterThan(0);
    // The entrance column is reserved as the gate (the controllable
    // breach), and it's part of the plan.
    const gatePacked = (sim.surfaceY[w.spawn.x] << 16) | w.spawn.x;
    expect(sim.gatePlanTile).toBe(gatePacked);
    expect(sim.fortificationPlan.includes(gatePacked)).toBe(true);
    // Wall + gate tiles sit on the surface row; trap tiles (planned
    // in the kill zone behind the gate) sit below it.
    for (const p of sim.fortificationPlan) {
      const x = p & 0xffff;
      const y = (p >>> 16) & 0xffff;
      if (sim.trapPlanTiles.includes(p)) {
        expect(y).toBeGreaterThan(sim.surfaceY[x]);
      } else {
        expect(y).toBe(sim.surfaceY[x]);
      }
    }
  });

  it("a hostile will not step onto a fortification tile", () => {
    const w = generateWorld({ seed: 913, width: 200, height: 500 });
    const sim = new SimWorld(913, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // A dwarf to lure the hostile, a wall between them.
    const dwarfId = sim.spawnDwarf({ name: "Bait", x: sx, y: sy, age: 30 });
    const wallX = sx + 1;
    sim.grid.setTile(wallX, sy, TileType.Fortification);
    // Hostile on the far side of the wall from the dwarf.
    const hostileId = sim.spawnHostile({ kind: "goblin_scout", x: sx + 2, y: sy });
    let everOnWall = false;
    for (let i = 0; i < 400; i++) {
      const n = sim.needs.get(dwarfId);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      // Pin the dwarf so the hostile keeps trying to reach it through
      // the wall rather than wandering off.
      const dp = sim.position.get(dwarfId);
      if (dp) { dp.x = sx; dp.y = sy; }
      tick(sim);
      const hp = sim.position.get(hostileId);
      if (hp && hp.x === wallX && hp.y === sy) everOnWall = true;
      if (!sim.ecs.isAlive(hostileId)) break;
    }
    expect(everOnWall).toBe(false);
  });

  it("masons raise the planned wall, spending a block per segment", () => {
    const w = generateWorld({ seed: 915, width: 200, height: 500 });
    const sim = new SimWorld(915, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 12; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    sim.stockpile.blocks = 50;
    // Let the architect plan, then let the masons build.
    let planned = 0;
    for (let i = 0; i < TICKS_PER_DAY * 30; i++) {
      feedAll(sim);
      tick(sim);
      if (sim.fortificationPlan.length > 0) planned = Math.max(planned, sim.fortificationPlan.length);
      // Stop once at least one segment has gone up.
      if (planned > 0 && sim.fortificationPlan.length < planned) break;
    }
    expect(planned).toBeGreaterThan(0);
    // At least one fortification tile now stands on the entrance row.
    let builtTiles = 0;
    for (let dx = -8; dx <= 8; dx++) {
      const x = w.spawn.x + dx;
      if (sim.grid.getTile(x, sim.surfaceY[x]) === TileType.Fortification) builtTiles++;
    }
    expect(builtTiles).toBeGreaterThan(0);
    // Blocks were consumed (one per built segment).
    expect(sim.stockpile.blocks).toBeLessThan(50);
  });

  it("a pending rampart plan round-trips through save/restore", async () => {
    const { snapshot, restore } = await import("../save/snapshot");
    const w = generateWorld({ seed: 917, width: 200, height: 500 });
    const sim = new SimWorld(917, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Keeper", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.fortificationPlan = [(5 << 16) | 10, (5 << 16) | 12];
    const save = snapshot({
      sim,
      slotId: "slot-1",
      fortressName: "fortress",
      mode: "legacy",
      cameraX: 0,
      cameraY: 0,
      zoomIndex: 1,
    });
    const restored = restore(save);
    expect(restored.fortificationPlan).toEqual([(5 << 16) | 10, (5 << 16) | 12]);
  });
});
