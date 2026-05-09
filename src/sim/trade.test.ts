import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_DAY } from "./time";
import { Blueprint } from "./planner/blueprint";

const SEASON = TICKS_PER_DAY * 6;

/** Plant a synthetic completed trade depot near spawn so the trade
 * system fires on the next season boundary. */
function plantDepot(sim: SimWorld): Blueprint {
  const ox = sim.spawn.x + 2;
  const oy = sim.spawn.y;
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 4; yy++) {
    for (let xx = ox; xx < ox + 5; xx++) cavity.push((yy << 16) | xx);
  }
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
    for (let i = 0; i < SEASON + 5; i++) {
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
    for (let i = 0; i < SEASON + 5; i++) {
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
    for (let i = 0; i < SEASON + 5; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.stockpile.stone).toBe(stoneBefore);
  });

  it("a caravan with no stone in the stockpile leaves empty-handed and logs an event", () => {
    const w = generateWorld({ seed: 97, width: 200, height: 500 });
    const sim = new SimWorld(97, w.grid, w.surfaceY, w.spawn);
    plantDepot(sim);
    sim.spawnDwarf({ name: "Broker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.stone = 0;
    for (let i = 0; i < SEASON + 5; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    const empty = sim.events.events.find((e) => e.text.includes("empty-handed"));
    expect(empty).toBeDefined();
  });
});
