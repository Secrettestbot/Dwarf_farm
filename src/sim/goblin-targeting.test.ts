import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

/** Carve a wide flat corridor around a tile so hostiles and
 * dwarves can move freely for the test. */
function carveArena(sim: SimWorld, cx: number, cy: number, r: number) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      sim.grid.setTile(cx + dx, cy + dy, TileType.CorridorFloor);
    }
  }
}

/** Pin a dwarf in place with an in-progress sleep-on-the-spot job so
 * idle wandering can't move the bait around mid-test. Sleep is a
 * survival job — the interrupt pass never cancels it, and at 60-80
 * test ticks it neither completes nor refills past the 95 cutoff. */
function pinDwarf(sim: SimWorld, id: number) {
  const pos = sim.position.get(id)!;
  sim.needs.get(id)!.sleep = 0;
  sim.job.set(id, { kind: "sleep", targetX: pos.x, targetY: pos.y, progress: 0 });
}

describe("goblin target priority", () => {
  it("a goblin scout prefers the mayor over an equally-distant non-mayor", () => {
    const w = generateWorld({ seed: 1101, width: 200, height: 500 });
    const sim = new SimWorld(1101, w.grid, w.surfaceY, w.spawn);
    carveArena(sim, w.spawn.x, w.spawn.y, 8);
    // Mayor on the left of the goblin, regular on the right —
    // both 4 tiles away. The mayor priority should pull the
    // goblin left.
    const mayor = sim.spawnDwarf({ name: "TheMayor", x: w.spawn.x - 4, y: w.spawn.y, age: 30 });
    const regular = sim.spawnDwarf({ name: "Regular", x: w.spawn.x + 4, y: w.spawn.y, age: 30 });
    pinDwarf(sim, mayor);
    pinDwarf(sim, regular);
    sim.mayorName = "TheMayor";
    const gobId = sim.spawnHostile({ kind: "goblin_scout", x: w.spawn.x, y: w.spawn.y });
    // Step the sim for a few ticks. Goblin moveCooldown is 22, so
    // we need at least ~25 ticks for the first move.
    for (let i = 0; i < 60; i++) tick(sim);
    const pos = sim.position.get(gobId);
    expect(pos).toBeDefined();
    // After moving, goblin should be west of its start tile (toward the mayor).
    expect(pos!.x).toBeLessThan(w.spawn.x);
  });

  it("a goblin warlord ignores a far adult civilian to chase a closer child", () => {
    const w = generateWorld({ seed: 1103, width: 200, height: 500 });
    const sim = new SimWorld(1103, w.grid, w.surfaceY, w.spawn);
    carveArena(sim, w.spawn.x, w.spawn.y, 12);
    // Child 2 tiles west, adult 8 tiles east. Child wins purely
    // on softness + the closer distance — even if both dwarves
    // wander a few tiles in the test window, the warlord should
    // still chase the child.
    const adult = sim.spawnDwarf({ name: "Adult", x: w.spawn.x + 8, y: w.spawn.y, age: 30 });
    const tot = sim.spawnDwarf({ name: "Tot", x: w.spawn.x - 2, y: w.spawn.y, age: 6 });
    pinDwarf(sim, adult);
    pinDwarf(sim, tot);
    const gobId = sim.spawnHostile({ kind: "goblin_warlord", x: w.spawn.x, y: w.spawn.y });
    for (let i = 0; i < 60; i++) tick(sim);
    const pos = sim.position.get(gobId);
    expect(pos).toBeDefined();
    // After moving, warlord should be west of its start tile.
    expect(pos!.x).toBeLessThan(w.spawn.x);
  });

  it("a cave rat (non-goblin) ignores target softness and goes for the nearest body", () => {
    const w = generateWorld({ seed: 1105, width: 200, height: 500 });
    const sim = new SimWorld(1105, w.grid, w.surfaceY, w.spawn);
    carveArena(sim, w.spawn.x, w.spawn.y, 8);
    // Mayor 5 tiles east, regular 3 tiles west. Mayor priority
    // would pull a goblin east; the cave rat ignores priority and
    // goes for the closer regular.
    const mayor = sim.spawnDwarf({ name: "TheMayor", x: w.spawn.x + 5, y: w.spawn.y, age: 30 });
    const closer = sim.spawnDwarf({ name: "Closer", x: w.spawn.x - 3, y: w.spawn.y, age: 30 });
    pinDwarf(sim, mayor);
    pinDwarf(sim, closer);
    sim.mayorName = "TheMayor";
    const ratId = sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x, y: w.spawn.y });
    for (let i = 0; i < 80; i++) tick(sim);
    const pos = sim.position.get(ratId);
    expect(pos).toBeDefined();
    // Rat should drift west toward the closer regular.
    expect(pos!.x).toBeLessThan(w.spawn.x);
  });
});
