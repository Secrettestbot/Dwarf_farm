import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

/** Synthetic completed brewery next to spawn (same pattern as
 * workshops.test.ts) so a dwarf can walk in and start crafting. */
function plantBrewery(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      cavity.push((yy << 16) | xx);
    }
  }
  sim.grid.setTile(ox + 1, oy + 1, TileType.BreweryStation);
  const bp: Blueprint = {
    id: 9000,
    kind: "brewery",
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

describe("craft input refunds", () => {
  it("an interrupted craft refunds the consumed input", () => {
    const w = generateWorld({ seed: 4401, width: 200, height: 500 });
    const sim = new SimWorld(4401, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantBrewery(sim, w.spawn.x + 2, w.spawn.y - 1);
    const e = sim.spawnDwarf({ name: "Brewer", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    sim.stockpile.food = 50;
    sim.stockpile.drink = 100;
    const foodBefore = sim.stockpile.food;
    // Walk in and start the craft (inputs consumed on the first
    // progress tick at the station).
    let started = false;
    for (let i = 0; i < 60 && !started; i++) {
      tick(sim);
      const job = sim.job.get(e);
      started = job?.kind === "craft" && job.progress > 0;
    }
    expect(started).toBe(true);
    expect(sim.stockpile.food).toBeLessThan(foodBefore);
    // Interrupt mid-craft via critical thirst (drink is stocked, so
    // the interrupt pass fires) — the consumed food must come back.
    n.thirst = 5;
    tick(sim);
    expect(sim.job.get(e)?.kind).not.toBe("craft");
    expect(sim.stockpile.food).toBe(foodBefore);
  });
});

describe("soldier retreat", () => {
  it("a badly wounded soldier breaks off and seeks a bed instead of engaging", () => {
    const w = generateWorld({ seed: 4403, width: 200, height: 500 });
    const sim = new SimWorld(4403, w.grid, w.surfaceY, w.spawn);
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        sim.grid.setTile(w.spawn.x + dx, w.spawn.y + dy, TileType.CorridorFloor);
      }
    }
    const e = sim.spawnDwarf({ name: "Guard", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(e)!;
    // sleep below the instant-completion cutoff (95) so the rest job
    // the wounded branch issues actually persists past the same tick.
    n.hunger = 100; n.thirst = 100; n.sleep = 50; n.social = 100;
    sim.squad.set(e, { draftedAtTick: 0 });
    const hp = sim.health.get(e)!;
    hp.hp = Math.floor(hp.maxHp * 0.2);
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 5, y: w.spawn.y });
    tick(sim);
    const job = sim.job.get(e);
    expect(job?.kind).not.toBe("engage");
    // The wounded branch routes them to rest.
    expect(job?.kind).toBe("sleep");
  });

  it("a healthy soldier still engages", () => {
    const w = generateWorld({ seed: 4405, width: 200, height: 500 });
    const sim = new SimWorld(4405, w.grid, w.surfaceY, w.spawn);
    for (let dx = -8; dx <= 8; dx++) {
      sim.grid.setTile(w.spawn.x + dx, w.spawn.y, TileType.CorridorFloor);
    }
    const e = sim.spawnDwarf({ name: "Guard", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    sim.squad.set(e, { draftedAtTick: 0 });
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 5, y: w.spawn.y });
    tick(sim);
    expect(sim.job.get(e)?.kind).toBe("engage");
  });
});
