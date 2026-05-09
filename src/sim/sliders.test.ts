import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { defaultSliders } from "./sliders";

describe("priority sliders", () => {
  it("starts every category at the neutral 0.5 default", () => {
    const w = generateWorld({ seed: 11, width: 200, height: 500 });
    const sim = new SimWorld(11, w.grid, w.surfaceY, w.spawn);
    const s = sim.sliders;
    expect(s).toEqual(defaultSliders());
  });

  it("excavation=0 gates mining off", () => {
    const w = generateWorld({ seed: 13, width: 200, height: 500 });
    const sim = new SimWorld(13, w.grid, w.surfaceY, w.spawn);
    sim.sliders.excavation = 0;
    sim.sliders.farming = 0;
    sim.sliders.construction = 0;
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Pin needs so the dwarf doesn't bail out to eat / drink instead.
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    // Run long enough that the planner emits at least one mineable cavity.
    for (let i = 0; i < 500; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // No dwarf should be mining since excavation is gated off — even if
    // there are mineable tiles in active blueprints.
    let mineJobs = 0;
    for (const d of sim.dwarf.entities) {
      const j = sim.job.get(d);
      if (j?.kind === "mine") mineJobs++;
    }
    expect(mineJobs).toBe(0);
  });

  it("excavation>0 lets dwarves take mine jobs", () => {
    const w = generateWorld({ seed: 13, width: 200, height: 500 });
    const sim = new SimWorld(13, w.grid, w.surfaceY, w.spawn);
    // Defaults are 0.5 — leave excavation at the default.
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    let everMined = false;
    for (let i = 0; i < 500 && !everMined; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      for (const d of sim.dwarf.entities) {
        const j = sim.job.get(d);
        if (j?.kind === "mine") everMined = true;
      }
    }
    expect(everMined).toBe(true);
  });
});
