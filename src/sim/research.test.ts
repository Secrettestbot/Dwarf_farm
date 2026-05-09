import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { nextTopic, defaultResearch, ALL_TOPICS } from "./research";
import { Blueprint } from "./planner/blueprint";

describe("research tree", () => {
  it("Tier 1 topics have no prereqs and are picked first", () => {
    const t = nextTopic(defaultResearch());
    expect(t).not.toBeNull();
    expect(t!.tier).toBe(1);
  });

  it("a Tier 2 topic only becomes available once its prereqs are complete", () => {
    const r = defaultResearch();
    r.completed = ["basic_carpentry", "rope_and_fibre"];
    // Now Carpentry: Mechanisms is unlocked but the cheap Tier 1 topics
    // still come first.
    const t = nextTopic(r);
    expect(t).not.toBeNull();
    expect(t!.tier).toBe(1);
    // Once every Tier 1 is done, Tier 2 starts surfacing.
    r.completed = ALL_TOPICS.filter((t) => t.tier === 1).map((t) => t.id);
    const next = nextTopic(r);
    expect(next?.tier).toBe(2);
  });

  it("a scholar at a library desk advances research progress", () => {
    const w = generateWorld({ seed: 101, width: 200, height: 500 });
    const sim = new SimWorld(101, w.grid, w.surfaceY, w.spawn);
    // Plant a synthetic complete Library.
    const ox = w.spawn.x + 2;
    const oy = w.spawn.y;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 4; xx++) {
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
        cavity.push((yy << 16) | xx);
      }
    }
    sim.grid.setTile(ox + 1, oy, TileType.LibraryDesk);
    const bp: Blueprint = {
      id: 9200,
      kind: "library",
      originX: ox,
      originY: oy,
      width: 4,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "complete",
      priority: 1,
      createdTick: 0,
    };
    sim.planner.blueprints.push(bp);
    // Carve a corridor so the scholar can reach the library.
    for (let xx = w.spawn.x; xx <= ox; xx++) sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    sim.spawnDwarf({ name: "Scholar", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    sim.dwarf.get(e)!.skills.scholarship = 5;
    // Pin needs.
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // Either we made progress on a topic, or already finished one of the
    // cheap topics outright.
    expect(sim.research.completed.length + (sim.research.progress > 0 ? 1 : 0)).toBeGreaterThan(0);
  });
});
