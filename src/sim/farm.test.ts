import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Rng } from "./rng";
import { ColonyPlanner } from "./planner/colonyPlanner";

describe("farms", () => {
  it("the planner emits a farm once population reaches 4", () => {
    const w = generateWorld({ seed: 51, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(2024);
    // The architect prioritises dining hall first; hand-excavate active
    // blueprints each tick so the planner moves on to the farm slot in a
    // few evaluations.
    for (let t = 1; t <= 1200; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 4, rng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7); // CorridorFloor
        }
      }
    }
    const hasFarm = planner.blueprints.some((b) => b.kind === "farm");
    expect(hasFarm).toBe(true);
  });

  it("a completed farm cavity is filled with FarmTile cells", () => {
    const w = generateWorld({ seed: 53, width: 200, height: 500 });
    const sim = new SimWorld(53, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 4; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + i, y: w.spawn.y, age: 30 });
    }
    // Hand-excavate any farm blueprint emitted so the planner harvests it.
    for (let i = 0; i < 600; i++) {
      tick(sim);
      for (const bp of sim.planner.blueprints) {
        if (bp.kind !== "farm" || bp.status !== "digging") continue;
        for (let k = 0; k < bp.cavity.length; k++) {
          const c = bp.cavity[k];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          sim.grid.setTile(x, y, TileType.CorridorFloor);
        }
      }
    }
    const farm = sim.planner.blueprints.find((b) => b.kind === "farm");
    expect(farm).toBeDefined();
    if (!farm) return;
    // After harvestCompleted the cavity should be FarmTile, not CorridorFloor.
    let farmCells = 0;
    for (let i = 0; i < farm.cavity.length; i++) {
      const c = farm.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.FarmTile) farmCells++;
    }
    expect(farmCells).toBeGreaterThan(0);
  });

  it("FarmTiles produce food into the stockpile over time", () => {
    const w = generateWorld({ seed: 57, width: 200, height: 500 });
    const sim = new SimWorld(57, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D0", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Drop existing food to zero so the increase is unambiguous.
    sim.stockpile.food = 0;
    // Plant a small farm by hand: place a 'farm' blueprint, mark complete,
    // and call furnishRoom-equivalent — easier: directly set a few tiles
    // to FarmTile and add a synthetic completed farm blueprint to the
    // planner so farmSystem iterates over it.
    const cavity = new Int32Array([
      (w.spawn.y + 1 << 16) | (w.spawn.x + 1),
      (w.spawn.y + 1 << 16) | (w.spawn.x + 2),
      (w.spawn.y + 1 << 16) | (w.spawn.x + 3),
    ]);
    for (let k = 0; k < cavity.length; k++) {
      const c = cavity[k];
      sim.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, TileType.FarmTile);
    }
    const farm = {
      id: 9999,
      kind: "farm" as const,
      originX: w.spawn.x + 1,
      originY: w.spawn.y + 1,
      width: 3,
      height: 1,
      cavity,
      status: "complete" as const,
      priority: 1,
      createdTick: 0,
      // Tended cells produce food; pin them as just-tended every tick so
      // we're testing yield, not the tending rhythm.
      cellTendedAt: new Int32Array(cavity.length),
    };
    sim.planner.blueprints.push(farm);
    for (let i = 0; i < 1500; i++) {
      farm.cellTendedAt.fill(sim.tick);
      tick(sim);
    }
    // Yield is now an item entity dropped on the cell, not a counter
    // bump — count both. Whichever path the food took, "the farm
    // produced something" should hold.
    let foodItems = 0;
    for (const ie of sim.item.entities) {
      if (sim.item.get(ie)?.kind === "food") foodItems++;
    }
    expect(sim.stockpile.food + foodItems).toBeGreaterThan(0);
  });
});
