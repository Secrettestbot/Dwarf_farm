import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

/** Plant a synthetic completed workshop next to spawn so a dwarf can
 * walk in and start crafting. Mirrors the helper in workshops.test.ts
 * but kept local so the two test files stay independent. */
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
  const cx = ox + 1;
  const cy = oy + 1;
  sim.grid.setTile(cx, cy, station);
  const bp: Blueprint = {
    id: 8500,
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

describe("workshop item routing", () => {
  it("a hauler delivers a loose ore to the smelter station", () => {
    const w = generateWorld({ seed: 401, width: 200, height: 500 });
    const sim = new SimWorld(401, w.grid, w.surfaceY, w.spawn);
    // Carve a corridor connecting spawn to the smelter.
    for (let xx = w.spawn.x; xx <= w.spawn.x + 5; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "smelter", TileType.SmelterStation, w.spawn.x + 3, w.spawn.y - 1);
    // Drop a loose ore item next to the dwarf and start with empty
    // stockpile so the smelter can only run if it gets the routed item.
    sim.spawnItem({ kind: "ore", x: w.spawn.x + 1, y: w.spawn.y });
    sim.spawnDwarf({ name: "Hauler", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.ore = 0;
    sim.stockpile.bars = 0;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 600; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // The smelter should have produced bars without ever touching the
    // global ore counter.
    // Bars come out as items first; without a stockpile or forge to
    // deliver to, the smith may end the run still carrying. Count all
    // three places the bar might live.
    let barItems = 0;
    for (const ie of sim.item.entities) {
      if (sim.item.get(ie)?.kind === "bars") barItems++;
    }
    let carriedBars = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.carrying.get(id)?.kind === "bars") carriedBars++;
    }
    expect(sim.stockpile.bars + barItems + carriedBars).toBeGreaterThan(0);
    expect(sim.stockpile.ore).toBe(0);
  });

  it("an ore item delivered to a smelter station is consumed by the next craft", () => {
    const w = generateWorld({ seed: 403, width: 200, height: 500 });
    const sim = new SimWorld(403, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 5; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    const bp = plantWorkshop(sim, "smelter", TileType.SmelterStation, w.spawn.x + 3, w.spawn.y - 1);
    const stationX = bp.originX + 1;
    const stationY = bp.originY + 1;
    // Drop an ore item directly on the smelter station (simulating a
    // hauler having just dropped it).
    sim.spawnItem({ kind: "ore", x: stationX, y: stationY });
    sim.spawnDwarf({ name: "Smith", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.ore = 0;
    sim.stockpile.bars = 0;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 400; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // Bars come out as items first; without a stockpile or forge to
    // deliver to, the smith may end the run still carrying. Count all
    // three places the bar might live.
    let barItems = 0;
    for (const ie of sim.item.entities) {
      if (sim.item.get(ie)?.kind === "bars") barItems++;
    }
    let carriedBars = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.carrying.get(id)?.kind === "bars") carriedBars++;
    }
    expect(sim.stockpile.bars + barItems + carriedBars).toBeGreaterThan(0);
    // The pre-placed ore item should have been consumed by the smith.
    let oreItemsLeft = 0;
    for (const ie of sim.item.entities) {
      if (sim.item.get(ie)?.kind === "ore") oreItemsLeft++;
    }
    expect(oreItemsLeft).toBe(0);
  });

  it("end-to-end: a smelter's bar item routes onward to a forge", () => {
    const w = generateWorld({ seed: 407, width: 200, height: 500 });
    const sim = new SimWorld(407, w.grid, w.surfaceY, w.spawn);
    // Carve a long corridor: dwarf at left, smelter middle, forge right.
    for (let xx = w.spawn.x; xx <= w.spawn.x + 12; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "smelter", TileType.SmelterStation, w.spawn.x + 3, w.spawn.y - 1);
    const forge = plantWorkshop(sim, "forge", TileType.ForgeStation, w.spawn.x + 8, w.spawn.y - 1);
    forge.id = 8501; // distinct id from the smelter
    // Plenty of ore to seed the chain — bars come from items only.
    sim.stockpile.ore = 20;
    sim.stockpile.bars = 0;
    sim.stockpile.tools = 0;
    sim.spawnDwarf({ name: "Smith", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.spawnDwarf({ name: "Hauler", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    for (let i = 0; i < 1500; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    // The forge should have produced at least one tool (item or counter
    // or carried), proving the smelter→forge item chain works end-to-end.
    let toolItems = 0;
    for (const ie of sim.item.entities) {
      if (sim.item.get(ie)?.kind === "tools") toolItems++;
    }
    let carriedTools = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.carrying.get(id)?.kind === "tools") carriedTools++;
    }
    expect(sim.stockpile.tools + toolItems + carriedTools).toBeGreaterThan(0);
  });

  it("workshops without a routed item still draw from the global stockpile", () => {
    // Brewery accepts food via the counter when no food items are
    // routed to its station — the GDD-aligned flow where the colony's
    // raw harvest sits in a stockpile until a brewer draws from it.
    const w = generateWorld({ seed: 405, width: 200, height: 500 });
    const sim = new SimWorld(405, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 5; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantWorkshop(sim, "brewery", TileType.BreweryStation, w.spawn.x + 3, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Brewer", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.food = 50;
    const foodBefore = sim.stockpile.food;
    const drinkBefore = sim.stockpile.drink;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 400; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // Brewery consumed food from the counter (the stockpile fallback).
    expect(sim.stockpile.food).toBeLessThan(foodBefore);
    // Drink output drops as items at the station; count items + counter
    // + carry as the brewery's effective output.
    let drinkItems = 0;
    for (const ie of sim.item.entities) {
      if (sim.item.get(ie)?.kind === "drink") drinkItems++;
    }
    let carriedDrink = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.carrying.get(id)?.kind === "drink") carriedDrink++;
    }
    expect(sim.stockpile.drink + drinkItems + carriedDrink).toBeGreaterThan(drinkBefore);
  });
});
