import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

function plantSmelter(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      cavity.push((yy << 16) | xx);
    }
  }
  sim.grid.setTile(ox + 1, oy + 1, TileType.SmelterStation);
  const bp: Blueprint = {
    id: 9800,
    kind: "smelter",
    originX: ox,
    originY: oy,
    width: 3,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("workshop quality (GDD §6.3)", () => {
  it("a Legendary smith produces high-quality bars over many crafts", () => {
    const w = generateWorld({ seed: 1001, width: 200, height: 500 });
    const sim = new SimWorld(1001, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 5; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantSmelter(sim, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Legend", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    sim.dwarf.get(e)!.skills.smithing = 18; // Legendary
    sim.stockpile.ore = 200;
    // Run long enough for several crafts.
    for (let i = 0; i < 4000; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // Most bars produced should be quality ≥ 2 (Superior+).
    let highQ = 0;
    let totalBars = 0;
    for (const ie of sim.item.entities) {
      const it = sim.item.get(ie);
      if (it?.kind !== "bars") continue;
      totalBars++;
      if ((it.quality ?? 0) >= 2) highQ++;
    }
    expect(totalBars).toBeGreaterThan(0);
    expect(highQ).toBeGreaterThan(0);
  });

  it("a Novice smith produces only basic-quality bars", () => {
    const w = generateWorld({ seed: 1003, width: 200, height: 500 });
    const sim = new SimWorld(1003, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 5; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantSmelter(sim, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Apprentice", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    sim.dwarf.get(e)!.skills.smithing = 1; // Novice
    sim.stockpile.ore = 50;
    for (let i = 0; i < 1500; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    let totalBars = 0;
    let highQ = 0;
    for (const ie of sim.item.entities) {
      const it = sim.item.get(ie);
      if (it?.kind !== "bars") continue;
      totalBars++;
      if ((it.quality ?? 0) > 0) highQ++;
    }
    expect(totalBars).toBeGreaterThan(0);
    expect(highQ).toBe(0);
  });

  it("equipping with a Masterwork tool stamps the weaponQuality", () => {
    const w = generateWorld({ seed: 1005, width: 200, height: 500 });
    const sim = new SimWorld(1005, w.grid, w.surfaceY, w.spawn);
    // Plant an armoury with one rack tile.
    sim.grid.setTile(w.spawn.x + 2, w.spawn.y, TileType.ArmouryRack);
    sim.planner.blueprints.push({
      id: 9801,
      kind: "armoury",
      originX: w.spawn.x + 2,
      originY: w.spawn.y,
      width: 1,
      height: 1,
      cavity: new Int32Array([(w.spawn.y << 16) | (w.spawn.x + 2)]),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Drop a Masterwork tool on the rack.
    sim.spawnItem({ kind: "tools", x: w.spawn.x + 2, y: w.spawn.y, quality: 4 });
    const id = sim.spawnDwarf({ name: "Recruit", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.military = 12;
    // Run a year so the draft fires.
    for (let i = 0; i < 24 * 60 * 24 + 5; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    const eq = sim.equipment.get(id);
    expect(eq?.weapon).toBe(true);
    expect(eq?.weaponQuality).toBe(4);
  });
});
