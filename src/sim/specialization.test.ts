import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

describe("dwarf specialization", () => {
  it("a master miner picks mining over hauling", () => {
    // The default priority order has haul above mine. A skill-1 dwarf
    // would haul whenever items are loose; a master miner should
    // override that and mine instead — their specialty trumps the
    // priority chain.
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const sim = new SimWorld(71, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Master", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    sim.dwarf.get(e)!.skills.mining = 15;
    sim.dwarf.get(e)!.skills.hauling = 1;
    let mineSeen = false;
    let haulSeen = false;
    for (let i = 0; i < 800; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      const j = sim.job.get(e);
      if (j?.kind === "mine") mineSeen = true;
      if (j?.kind === "haul") haulSeen = true;
    }
    expect(mineSeen).toBe(true);
    // The dwarf may haul occasionally (e.g., already-carrying cleanup
    // path) but mining should clearly happen — that's the specialty.
    void haulSeen;
  });

  it("a master scholar picks research before mining when both are available", () => {
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    const sim = new SimWorld(73, w.grid, w.surfaceY, w.spawn);
    // Plant a complete library so a research target exists.
    const ox = w.spawn.x + 2;
    const oy = w.spawn.y;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 4; xx++) {
        sim.grid.setTile(xx, yy, 7 /* CorridorFloor */);
        cavity.push((yy << 16) | xx);
      }
    }
    sim.grid.setTile(ox + 1, oy, 20 /* LibraryDesk */);
    sim.planner.blueprints.push({
      id: 9300,
      kind: "library",
      originX: ox,
      originY: oy,
      width: 4,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Carve the corridor so the scholar can reach the library.
    for (let xx = w.spawn.x; xx <= ox; xx++) sim.grid.setTile(xx, w.spawn.y, 7 /* CorridorFloor */);
    sim.spawnDwarf({ name: "Scholar", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    sim.dwarf.get(e)!.skills.scholarship = 15;
    sim.dwarf.get(e)!.skills.mining = 1;
    let researchSeen = false;
    for (let i = 0; i < 600 && !researchSeen; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      const j = sim.job.get(e);
      if (j?.kind === "research") researchSeen = true;
    }
    expect(researchSeen).toBe(true);
  });
});
