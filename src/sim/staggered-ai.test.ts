import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

describe("staggered AI (GDD §12.3)", () => {
  it("a small fortress runs chooseTask every tick — no latency for the player to feel", () => {
    const w = generateWorld({ seed: 601, width: 200, height: 500 });
    const sim = new SimWorld(601, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Solo", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    // Pin needs so chooseTask falls all the way through to wander, which
    // always produces a job at this scale.
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    tick(sim);
    expect(sim.job.has(e)).toBe(true);
  });

  it("a large fortress staggers — not every dwarf gets a job assigned on every tick", () => {
    const w = generateWorld({ seed: 603, width: 200, height: 500 });
    const sim = new SimWorld(603, w.grid, w.surfaceY, w.spawn);
    // Spawn ten dwarves in a row, all idle, all on the spawn floor.
    for (let i = 0; i < 10; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
    }
    for (const id of sim.dwarf.entities) {
      const n = sim.needs.get(id)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    }
    tick(sim);
    // With AI_BUCKET_COUNT=4 we'd expect roughly 1/4 of the dwarves to
    // get a job on the first tick — not all ten. The exact count is an
    // implementation detail; the property we care about is that not
    // every dwarf is processed every tick.
    let withJob = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.job.has(id)) withJob++;
    }
    expect(withJob).toBeLessThan(10);
    expect(withJob).toBeGreaterThan(0);
  });

  it("over four ticks every dwarf in a large fortress gets a chooseTask check", () => {
    const w = generateWorld({ seed: 605, width: 200, height: 500 });
    const sim = new SimWorld(605, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 8; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
    }
    for (const id of sim.dwarf.entities) {
      const n = sim.needs.get(id)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    }
    // Four ticks lets every bucket roll round at AI_BUCKET_COUNT=4.
    for (let i = 0; i < 4; i++) tick(sim);
    let withJob = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.job.has(id)) withJob++;
    }
    expect(withJob).toBe(8);
  });
});
