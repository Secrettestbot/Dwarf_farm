import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

describe("hauling", () => {
  it("mining drops a stone item entity at the mined location", () => {
    const w = generateWorld({ seed: 31, width: 200, height: 500 });
    const sim = new SimWorld(31, w.grid, w.surfaceY, w.spawn);
    // Plant a stone tile inside an active mine blueprint so the dwarf
    // actually digs it (chooseTask only mines what the planner has
    // committed the colony to).
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.grid.setTile(sx + 1, sy, TileType.Stone);
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
    sim.sliders.hauling = 0; // keep the dwarf focused on mining for this test
    sim.spawnDwarf({ name: "Borin", x: sx, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    let mined = false;
    for (let i = 0; i < 200 && !mined; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      mined = !sim.grid.isSolid(sx + 1, sy);
    }
    expect(mined).toBe(true);
    // The item dropped at the mined tile is a stone.
    let foundStone = false;
    for (const ie of sim.item.entities) {
      const it = sim.item.get(ie);
      const p = sim.position.get(ie);
      if (it?.kind === "stone" && p?.x === sx + 1 && p.y === sy) foundStone = true;
    }
    expect(foundStone).toBe(true);
  });

  it("hauling=0 keeps items on the floor (no haul jobs assigned)", () => {
    const w = generateWorld({ seed: 33, width: 200, height: 500 });
    const sim = new SimWorld(33, w.grid, w.surfaceY, w.spawn);
    sim.sliders.hauling = 0;
    sim.spawnItem({ kind: "stone", x: w.spawn.x + 1, y: w.spawn.y });
    sim.spawnDwarf({ name: "B", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    for (let i = 0; i < 60; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // The item is still there because no hauler is interested.
    expect(sim.item.entities.length).toBe(1);
  });

  it("a hauler picks up an item, walks it to the stockpile, and credits the counter", () => {
    const w = generateWorld({ seed: 35, width: 200, height: 500 });
    const sim = new SimWorld(35, w.grid, w.surfaceY, w.spawn);
    // Carve a stockpile next to the dwarf.
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    for (let xx = sx + 1; xx <= sx + 3; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const cavity = new Int32Array([
      (sy << 16) | (sx + 2),
      (sy << 16) | (sx + 3),
    ]);
    sim.planner.blueprints.push({
      id: 1,
      kind: "stockpile",
      originX: sx + 2,
      originY: sy,
      width: 2,
      height: 1,
      cavity,
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Drop a loose stone next to the dwarf.
    sim.spawnItem({ kind: "stone", x: sx + 1, y: sy });
    sim.spawnDwarf({ name: "B", x: sx, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    const before = sim.stockpile.stone;
    for (let i = 0; i < 200; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.stockpile.stone).toBeGreaterThan(before);
    expect(sim.item.entities.length).toBe(0);
    expect(sim.carrying.has(e)).toBe(false);
  });
});
