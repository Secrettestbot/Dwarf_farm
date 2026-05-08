import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

/** Plant a synthetic completed workshop next to spawn so a dwarf can
 * walk in and start crafting. Bypasses the planner's slot timing — the
 * planner emission is exercised separately by the planner tests. */
function plantWorkshop(
  sim: SimWorld,
  kind: "kitchen" | "brewery" | "smelter" | "forge",
  station: TileType,
  ox: number,
  oy: number,
): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      cavity.push((yy << 16) | xx);
    }
  }
  // The crafter stands on the centre tile.
  const cx = ox + 1;
  const cy = oy + 1;
  sim.grid.setTile(cx, cy, station);
  const bp: Blueprint = {
    id: 8000,
    kind,
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

describe("workshops", () => {
  it("a dwarf brews ale at a brewery — food drops, drink rises", () => {
    const w = generateWorld({ seed: 41, width: 200, height: 500 });
    const sim = new SimWorld(41, w.grid, w.surfaceY, w.spawn);
    // Carve a connecting corridor so the dwarf can reach the brewery.
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "brewery", TileType.BreweryStation, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Pin needs so the dwarf focuses on crafting.
    const e = sim.dwarf.entities[0];
    sim.stockpile.food = 50;
    sim.stockpile.drink = 100;
    const foodBefore = sim.stockpile.food;
    const drinkBefore = sim.stockpile.drink;
    for (let i = 0; i < 400; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.stockpile.food).toBeLessThan(foodBefore);
    expect(sim.stockpile.drink).toBeGreaterThan(drinkBefore);
  });

  it("crafting=0 disables the workshop loop", () => {
    const w = generateWorld({ seed: 43, width: 200, height: 500 });
    const sim = new SimWorld(43, w.grid, w.surfaceY, w.spawn);
    sim.sliders.crafting = 0;
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "brewery", TileType.BreweryStation, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    const foodBefore = sim.stockpile.food;
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // No food consumed — the brewery stayed cold.
    expect(sim.stockpile.food).toBe(foodBefore);
  });

  it("a smelter produces bars from ore", () => {
    const w = generateWorld({ seed: 47, width: 200, height: 500 });
    const sim = new SimWorld(47, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "smelter", TileType.SmelterStation, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.ore = 20;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 600; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.stockpile.bars).toBeGreaterThan(0);
    expect(sim.stockpile.ore).toBeLessThan(20);
  });

  it("a workshop with empty inputs yields no production", () => {
    const w = generateWorld({ seed: 49, width: 200, height: 500 });
    const sim = new SimWorld(49, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "smelter", TileType.SmelterStation, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.ore = 0;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.stockpile.bars).toBe(0);
  });
});
