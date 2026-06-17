import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_DAY } from "./time";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

const SEASON = TICKS_PER_DAY * 6;
// Walk-to-depot + negotiate window. The deferred-trade refactor
// means the deal closes only after the broker physically arrives,
// so the test loops have to cover the walk plus NEGOTIATE_TICKS.
// Pre-announcement adds ~3 days of lead time before the wagons
// actually park, so the window also has to cover that delay.
const TRADE_WINDOW = TICKS_PER_DAY * 5;

/** Plant a synthetic completed trade depot near spawn so the trade
 * system fires on the next season boundary. Carves the cavity
 * tiles to corridor floor so the broker can actually path in. */
function plantDepot(sim: SimWorld): Blueprint {
  const ox = sim.spawn.x + 2;
  const oy = sim.spawn.y;
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 4; yy++) {
    for (let xx = ox; xx < ox + 5; xx++) {
      cavity.push((yy << 16) | xx);
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  // Carve a corridor from spawn to the depot so a broker can reach it.
  for (let xx = sim.spawn.x; xx < ox; xx++) sim.grid.setTile(xx, sim.spawn.y, TileType.CorridorFloor);
  const bp: Blueprint = {
    id: 9100,
    kind: "trade_depot",
    originX: ox,
    originY: oy,
    width: 5,
    height: 4,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("trade caravans", () => {
  it("a season boundary with a depot and stockpile triggers a trade", () => {
    const w = generateWorld({ seed: 91, width: 200, height: 500 });
    const sim = new SimWorld(91, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 100;
    sim.stockpile.food = 100; // low → caravan brings food
    const stoneBefore = sim.stockpile.stone;
    const foodBefore = sim.stockpile.food;
    for (let i = 0; i < SEASON + TRADE_WINDOW; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.stockpile.stone).toBeLessThan(stoneBefore);
    expect(sim.stockpile.food).toBeGreaterThan(foodBefore);
  });

  it("Lockdown blocks the caravan", () => {
    const w = generateWorld({ seed: 93, width: 200, height: 500 });
    const sim = new SimWorld(93, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 100;
    const stoneBefore = sim.stockpile.stone;
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    for (let i = 0; i < SEASON + TRADE_WINDOW; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.stockpile.stone).toBe(stoneBefore);
  });

  it("no trade depot means no caravan", () => {
    const w = generateWorld({ seed: 95, width: 200, height: 500 });
    const sim = new SimWorld(95, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 100;
    const stoneBefore = sim.stockpile.stone;
    for (let i = 0; i < SEASON + TRADE_WINDOW; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.stockpile.stone).toBe(stoneBefore);
  });

  it("an outrider event fires a few days before the caravan arrives", () => {
    const w = generateWorld({ seed: 191, width: 200, height: 500 });
    const sim = new SimWorld(191, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 100;
    sim.stockpile.food = 100;
    let outriderTick = -1;
    let arrivalTick = -1;
    for (let i = 0; i < SEASON + TRADE_WINDOW; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      const last = sim.events.events[sim.events.events.length - 1];
      if (last) {
        if (outriderTick < 0 && last.text.includes("outrider")) outriderTick = sim.tick;
        else if (arrivalTick < 0 && last.text.includes("arrives at the Trade Depot")) arrivalTick = sim.tick;
      }
    }
    expect(outriderTick).toBeGreaterThan(0);
    expect(arrivalTick).toBeGreaterThan(outriderTick);
    expect(arrivalTick - outriderTick).toBeGreaterThanOrEqual(TICKS_PER_DAY * 2);
  });

  it("a successful deal raises the kingdom's trade reputation", () => {
    const w = generateWorld({ seed: 193, width: 200, height: 500 });
    const sim = new SimWorld(193, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 100;
    sim.stockpile.food = 100;
    expect(Object.keys(sim.tradeReputation).length).toBe(0);
    for (let i = 0; i < SEASON + TRADE_WINDOW; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    // After the deal closes the visiting kingdom's reputation
    // entry should exist and be > 0.
    const reps = Object.values(sim.tradeReputation);
    expect(reps.length).toBeGreaterThan(0);
    expect(Math.max(...reps)).toBeGreaterThan(0);
  });

  it("a caravan with no stone in the stockpile leaves empty-handed and logs an event", () => {
    const w = generateWorld({ seed: 97, width: 200, height: 500 });
    const sim = new SimWorld(97, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 0;
    for (let i = 0; i < SEASON + TRADE_WINDOW; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    const empty = sim.events.events.find((e) => e.text.includes("empty-handed"));
    expect(empty).toBeDefined();
  });

  it("the offered stockpile being drained mid-negotiation aborts the deal without going negative", () => {
    // Regression: progressTrade used to subtract caravanDealCost
    // unconditionally. If a workshop consumed the offered resource
    // between arrival and the broker reaching the depot, the
    // stockpile counter went negative.
    const w = generateWorld({ seed: 199, width: 200, height: 500 });
    const sim = new SimWorld(199, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 100;
    sim.stockpile.food = 100;
    // Run until the caravan arrives and the broker is en route /
    // negotiating. We watch for the deal slot to populate.
    let dealStarted = false;
    for (let i = 0; i < SEASON + TRADE_WINDOW && !dealStarted; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (sim.caravanDealResource && !sim.caravanDealComplete) dealStarted = true;
    }
    expect(dealStarted).toBe(true);
    // Drain the offered resource so the broker can no longer pay.
    const offered = sim.caravanDealResource as keyof typeof sim.stockpile;
    (sim.stockpile as unknown as Record<string, number>)[offered] = 0;
    // Run until the caravan leaves so the deal resolves one way or
    // the other.
    for (let i = 0; i < TRADE_WINDOW + TICKS_PER_DAY * 2; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    // No counter went negative.
    expect(sim.stockpile.stone).toBeGreaterThanOrEqual(0);
    expect(sim.stockpile.blocks).toBeGreaterThanOrEqual(0);
    expect(sim.stockpile.bars).toBeGreaterThanOrEqual(0);
    expect(sim.stockpile.cut_gems).toBeGreaterThanOrEqual(0);
  });
});
