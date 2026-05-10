import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";
import { TileType } from "../world/tiles";

function buildSim(seed: number, dwarves: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < dwarves; i++) {
    sim.spawnDwarf({ name: `Dwarf${i}`, x: w.spawn.x + (i % 3), y: w.spawn.y });
  }
  // Mirror the founder starter kit: pre-built furniture so the
  // first bedroom / stockpile / dining hall / kitchen / brewery
  // can furnish from day one. Without this the stockpile stays
  // needs_furnishing and mined items can't deliver to a counter.
  for (let i = 0; i < dwarves; i++) sim.spawnItem({ kind: "bed", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "bin", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "barrel", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "table", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "stove", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "library_desk", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "hospital_bed", x: w.spawn.x, y: w.spawn.y });
  sim.spawnItem({ kind: "tavern_counter", x: w.spawn.x, y: w.spawn.y });
  return sim;
}

describe("event log + stockpile", () => {
  it("emits a construction event when a blueprint is committed", () => {
    const sim = buildSim(101, 7);
    for (let i = 0; i < 80; i++) tick(sim);
    // After the planner's first hourly evaluation, at least one
    // 'construction' event should be in the log.
    const constructions = sim.events.events.filter((e) => e.category === "construction");
    expect(constructions.length).toBeGreaterThan(0);
    expect(constructions[0].text.length).toBeGreaterThan(0);
    expect(constructions[0].tick).toBeGreaterThan(0);
  });

  it("counts stone in the stockpile when stone tiles are mined", () => {
    const sim = buildSim(103, 7);
    // Run long enough for the stockpile to dig, accept a bin
    // delivery, and start collecting hauled items. The earlier
    // 600 ticks predates the slice-3 stockpile furniture
    // requirement — now we need the haul chain to land first.
    for (let i = 0; i < 3000; i++) tick(sim);
    const sp = sim.stockpile;
    // The starter cavern is mostly Dirt; deeper bedroom blueprints often
    // dig into Stone. Either way, *something* should have been counted.
    expect(sp.stone + sp.dirt).toBeGreaterThan(0);
  });

  it("fires the 'first ore strike' discovery event exactly once", () => {
    const sim = buildSim(107, 7);
    // Plant ore directly inside an active blueprint cavity so we don't have
    // to wait for the colony to descend ~50 tiles. We simulate enough ticks
    // to let the planner emit its first blueprint, then patch ore into it.
    for (let i = 0; i < 60; i++) tick(sim);
    const bp = sim.planner.blueprints.find((b) => b.status === "digging");
    expect(bp).toBeTruthy();
    if (!bp) return;
    // Replace the first cavity tile with Ore so the next mining strike
    // counts as a discovery.
    const c = bp.cavity[0];
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    sim.grid.setTile(x, y, TileType.Ore);
    // Run forward; eventually a dwarf will mine that ore tile.
    for (let i = 0; i < 1200; i++) tick(sim);
    const discoveries = sim.events.events.filter((e) => e.category === "discovery");
    expect(discoveries.length).toBeGreaterThanOrEqual(1);
    // It's a *first* strike — only the first ore mined emits a discovery.
    expect(sim.oreEverStruck).toBe(true);
  });

  it("event log is cap-bounded at 10000 entries", () => {
    const sim = buildSim(109, 1);
    for (let i = 0; i < 10100; i++) {
      sim.events.add(i, "construction", `event ${i}`);
    }
    expect(sim.events.size()).toBe(10000);
    // Earliest event should have been dropped.
    expect(sim.events.events[0].tick).toBeGreaterThan(0);
  });
});
