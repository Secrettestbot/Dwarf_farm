import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

function plantFarm(sim: SimWorld, ox: number, oy: number, w: number, h: number): Blueprint {
  const cavity = new Int32Array(w * h);
  let i = 0;
  for (let yy = oy; yy < oy + h; yy++) {
    for (let xx = ox; xx < ox + w; xx++) {
      sim.grid.setTile(xx, yy, TileType.FarmTile);
      cavity[i++] = (yy << 16) | xx;
    }
  }
  const bp: Blueprint = {
    id: 9000,
    kind: "farm",
    originX: ox,
    originY: oy,
    width: w,
    height: h,
    cavity,
    status: "complete",
    priority: 1,
    createdTick: 0,
    cellTendedAt: new Int32Array(cavity.length),
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

function plantStockpile(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity = new Int32Array(2);
  cavity[0] = (oy << 16) | ox;
  cavity[1] = (oy << 16) | (ox + 1);
  sim.grid.setTile(ox, oy, TileType.CorridorFloor);
  sim.grid.setTile(ox + 1, oy, TileType.CorridorFloor);
  const bp: Blueprint = {
    id: 9100,
    kind: "stockpile",
    originX: ox,
    originY: oy,
    width: 2,
    height: 1,
    cavity,
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("food item routing", () => {
  it("a tended farm cell credits food directly to the stockpile counter", () => {
    const w = generateWorld({ seed: 501, width: 200, height: 500 });
    const sim = new SimWorld(501, w.grid, w.surfaceY, w.spawn);
    sim.stockpile.food = 0;
    const farm = plantFarm(sim, w.spawn.x + 1, w.spawn.y, 4, 1);
    for (let i = 0; i < 1500; i++) {
      farm.cellTendedAt!.fill(sim.tick);
      tick(sim);
    }
    // Farm yield bumps the counter directly now — earlier versions
    // spawned a food item entity per yield, but the haul chain
    // didn't scale past a 4-item cap per cell. progressCraft already
    // falls back to the stockpile counter when no input item sits
    // at the workshop station, so kitchens / breweries still work.
    expect(sim.stockpile.food).toBeGreaterThan(0);
  });

  it("a hauler delivers a food item to the stockpile, crediting the counter", () => {
    const w = generateWorld({ seed: 503, width: 200, height: 500 });
    const sim = new SimWorld(503, w.grid, w.surfaceY, w.spawn);
    // Carve corridor: spawn → food at +1 → stockpile at +3.
    for (let xx = w.spawn.x; xx <= w.spawn.x + 5; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    sim.spawnItem({ kind: "food", x: w.spawn.x + 1, y: w.spawn.y });
    plantStockpile(sim, w.spawn.x + 3, w.spawn.y);
    sim.spawnDwarf({ name: "Hauler", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.food = 0;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.stockpile.food).toBeGreaterThan(0);
  });

  it("a hungry dwarf prefers a meal over raw food when both are stocked", () => {
    const w = generateWorld({ seed: 505, width: 200, height: 500 });
    const sim = new SimWorld(505, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    sim.stockpile.food = 5;
    sim.stockpile.meals = 5;
    const needs = sim.needs.get(e)!;
    needs.hunger = 10; // critical
    needs.thirst = 100; needs.sleep = 100; needs.social = 100;
    // Run long enough for the eat job to complete.
    for (let i = 0; i < 100; i++) tick(sim);
    // The meal counter should have dropped — proving the meal was eaten
    // rather than raw food.
    expect(sim.stockpile.meals).toBeLessThan(5);
    expect(sim.stockpile.food).toBe(5);
  });
});
