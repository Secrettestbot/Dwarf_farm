import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

function carveArena(sim: SimWorld, cx: number, cy: number, r: number) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      sim.grid.setTile(cx + dx, cy + dy, TileType.CorridorFloor);
    }
  }
}

describe("civilian flee behavior", () => {
  it("a civilian with a hostile nearby takes a flee job toward the safe zone", () => {
    const w = generateWorld({ seed: 2201, width: 200, height: 500 });
    const sim = new SimWorld(2201, w.grid, w.surfaceY, w.spawn);
    carveArena(sim, w.spawn.x, w.spawn.y, 12);
    const d = sim.spawnDwarf({ name: "Runner", x: w.spawn.x + 8, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(d)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 11, y: w.spawn.y });
    // Several ticks: staggering is off at pop 1 so the first tick
    // already assigns; walk a few more so the dwarf gains ground.
    const startDist = 8;
    for (let i = 0; i < 6; i++) tick(sim);
    const job = sim.job.get(d);
    expect(job?.kind).toBe("flee");
    const pos = sim.position.get(d)!;
    expect(Math.abs(pos.x - w.spawn.x)).toBeLessThan(startDist);
  });

  it("a hostile approaching interrupts a civilian's work job", () => {
    const w = generateWorld({ seed: 2203, width: 200, height: 500 });
    const sim = new SimWorld(2203, w.grid, w.surfaceY, w.spawn);
    carveArena(sim, w.spawn.x, w.spawn.y, 12);
    const d = sim.spawnDwarf({ name: "Worker", x: w.spawn.x + 6, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(d)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    // Hand-plant a long-running non-survival job.
    sim.job.set(d, { kind: "wander", targetX: w.spawn.x + 6, targetY: w.spawn.y, progress: 0 });
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 8, y: w.spawn.y });
    tick(sim);
    const job = sim.job.get(d);
    expect(job?.kind).toBe("flee");
  });

  it("a drafted soldier does not flee — they engage", () => {
    const w = generateWorld({ seed: 2205, width: 200, height: 500 });
    const sim = new SimWorld(2205, w.grid, w.surfaceY, w.spawn);
    carveArena(sim, w.spawn.x, w.spawn.y, 12);
    const d = sim.spawnDwarf({ name: "Guard", x: w.spawn.x + 6, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(d)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    sim.squad.set(d, { draftedAtTick: 0 });
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 9, y: w.spawn.y });
    tick(sim);
    const job = sim.job.get(d);
    expect(job?.kind).toBe("engage");
  });
});
