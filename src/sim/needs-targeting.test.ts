import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

function plantFarm(sim: SimWorld, originX: number, originY: number, w: number, h: number, status: "complete" | "digging" = "complete"): Blueprint {
  const cavity = new Int32Array(w * h);
  let i = 0;
  for (let yy = originY; yy < originY + h; yy++) {
    for (let xx = originX; xx < originX + w; xx++) {
      cavity[i++] = (yy << 16) | xx;
      sim.grid.setTile(xx, yy, TileType.FarmTile);
    }
  }
  const cellTendedAt = new Int32Array(cavity.length).fill(sim.tick);
  const bp: Blueprint = {
    id: 9000 + Math.floor(Math.random() * 1000),
    kind: "farm",
    originX,
    originY,
    width: w,
    height: h,
    cavity,
    status,
    priority: 1,
    createdTick: 0,
    cellTendedAt,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("global room targeting", () => {
  it("a thirsty dwarf sets a drink job whose target is inside a stockpile, not next to them", () => {
    const w = generateWorld({ seed: 11, width: 200, height: 500 });
    const sim = new SimWorld(11, w.grid, w.surfaceY, w.spawn);
    const e = sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Carve a stockpile far away (10 tiles east) plus a connecting
    // corridor so pathfinding can actually reach it from spawn.
    const sx = w.spawn.x + 10;
    const sy = w.spawn.y;
    for (let xx = w.spawn.x + 1; xx < sx; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    const cavity: number[] = [];
    for (let yy = sy; yy < sy + 4; yy++) {
      for (let xx = sx; xx < sx + 5; xx++) {
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
        cavity.push((yy << 16) | xx);
      }
    }
    sim.planner.blueprints.push({
      id: 5001,
      kind: "stockpile",
      originX: sx,
      originY: sy,
      width: 5,
      height: 4,
      cavity: Int32Array.from(cavity),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Make the dwarf thirsty.
    const n = sim.needs.get(e)!;
    n.thirst = 20;
    n.hunger = 100;
    n.sleep = 100;
    // One tick to let chooseTask fire.
    tick(sim);
    const job = sim.job.get(e);
    expect(job?.kind).toBe("drink");
    // Target must be inside the stockpile cavity.
    const insideStockpile =
      job!.targetX >= sx && job!.targetX < sx + 5 &&
      job!.targetY >= sy && job!.targetY < sy + 4;
    expect(insideStockpile).toBe(true);
  });

  it("a sleepy dwarf far from any bedroom still picks a sleep target inside the bedroom", () => {
    const w = generateWorld({ seed: 13, width: 200, height: 500 });
    const sim = new SimWorld(13, w.grid, w.surfaceY, w.spawn);
    const e = sim.spawnDwarf({ name: "Helga", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Bedroom 8 tiles east — outside the 12-tile findRestSpot scan if we
    // also offset the dwarf far enough.
    const bx = w.spawn.x + 30;
    const by = w.spawn.y;
    const cells: number[] = [];
    for (let yy = by; yy < by + 3; yy++) {
      for (let xx = bx; xx < bx + 4; xx++) {
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
        cells.push((yy << 16) | xx);
      }
    }
    // Carve a corridor connecting spawn → bedroom so pathfinding works.
    for (let xx = w.spawn.x + 1; xx < bx; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    sim.grid.setTile(bx, by, TileType.Bed);
    sim.planner.blueprints.push({
      id: 5002,
      kind: "bedroom",
      originX: bx,
      originY: by,
      width: 4,
      height: 3,
      cavity: Int32Array.from(cells),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Force critical sleep.
    const n = sim.needs.get(e)!;
    n.sleep = 10;
    n.thirst = 100;
    n.hunger = 100;
    tick(sim);
    const job = sim.job.get(e);
    expect(job?.kind).toBe("sleep");
    // Target must be inside the bedroom — and prefer the Bed tile.
    expect(job!.targetX).toBeGreaterThanOrEqual(bx);
    expect(job!.targetX).toBeLessThan(bx + 4);
    expect(job!.targetY).toBeGreaterThanOrEqual(by);
    expect(job!.targetY).toBeLessThan(by + 3);
    // The Bed tile is at (bx, by), which is closest to spawn (bx, w.spawn.y).
    expect(job!.targetX).toBe(bx);
    expect(job!.targetY).toBe(by);
  });
});

describe("farm tending", () => {
  it("an untended cell yields no food", () => {
    const w = generateWorld({ seed: 21, width: 200, height: 500 });
    const sim = new SimWorld(21, w.grid, w.surfaceY, w.spawn);
    // No adult dwarves — otherwise they'd take a tend job and the farm
    // would re-tend itself before the test can observe the no-yield.
    sim.stockpile.food = 0;
    const farm = plantFarm(sim, w.spawn.x + 5, w.spawn.y, 2, 2);
    farm.cellTendedAt!.fill(-1);
    for (let i = 0; i < 360; i++) tick(sim);
    expect(sim.stockpile.food).toBe(0);
  });

  it("a freshly-tended cell yields food", () => {
    const w = generateWorld({ seed: 23, width: 200, height: 500 });
    const sim = new SimWorld(23, w.grid, w.surfaceY, w.spawn);
    sim.stockpile.food = 0;
    const farm = plantFarm(sim, w.spawn.x + 5, w.spawn.y, 4, 3);
    // Pin all cells as tended right now, every tick — simulates a colony
    // that keeps the farm fully maintained. No dwarves needed.
    for (let i = 0; i < 1500; i++) {
      farm.cellTendedAt!.fill(sim.tick);
      tick(sim);
    }
    expect(sim.stockpile.food).toBeGreaterThan(0);
  });

  it("a tended cell goes fallow after the validity window expires", () => {
    const w = generateWorld({ seed: 27, width: 200, height: 500 });
    const sim = new SimWorld(27, w.grid, w.surfaceY, w.spawn);
    sim.stockpile.food = 0;
    const farm = plantFarm(sim, w.spawn.x + 5, w.spawn.y, 2, 2);
    // No dwarves so nobody re-tends. Tend once, then watch the yield drop
    // to zero after the validity window expires.
    farm.cellTendedAt!.fill(sim.tick);
    for (let i = 0; i < 720 + 60; i++) tick(sim);
    const foodAtCutoff = sim.stockpile.food;
    for (let i = 0; i < 24 * 60; i++) tick(sim);
    expect(sim.stockpile.food).toBe(foodAtCutoff);
  });

  it("an idle dwarf adjacent to a fallow farm cell takes a tend job", () => {
    const w = generateWorld({ seed: 29, width: 200, height: 500 });
    const sim = new SimWorld(29, w.grid, w.surfaceY, w.spawn);
    const e = sim.spawnDwarf({ name: "D0", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Plant a fallow farm right at the spawn.
    const farm = plantFarm(sim, w.spawn.x + 1, w.spawn.y, 2, 1);
    farm.cellTendedAt!.fill(-1);
    // Pin needs so chooseTask doesn't divert.
    for (let i = 0; i < 5; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100;
      tick(sim);
    }
    const job = sim.job.get(e);
    expect(job?.kind).toBe("tend");
  });
});
