import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TIER_5_TOPICS, TIER_6_TOPICS, TOPICS_BY_ID, nextTopic, defaultResearch } from "./research";
import { TICKS_PER_DAY } from "./time";

describe("endgame content", () => {
  it("the research tree includes Tier 5 and Tier 6 topics", () => {
    expect(TIER_5_TOPICS.length).toBeGreaterThanOrEqual(4);
    expect(TIER_6_TOPICS.length).toBeGreaterThanOrEqual(3);
    expect(TOPICS_BY_ID["the_kings_name"]).toBeDefined();
    expect(TOPICS_BY_ID["the_kings_name"].tier).toBe(6);
  });

  it("higher tiers don't surface until their prereqs are met", () => {
    const r = defaultResearch();
    // Mark only the Tier 1 + 2 topics complete.
    r.completed = [
      "basic_stonecutting", "basic_carpentry", "iron_smelting", "iron_toolmaking",
      "basic_cooking", "basic_brewing", "rope_and_fibre",
      "masonry_and_mortaring", "carpentry_mechanisms", "steel_alloying",
      "armoury_basics", "medical_practice", "textile_craft",
      "underground_agriculture", "minecart_tracks", "pottery_and_kilns",
      "hydraulic_basics",
    ];
    const t = nextTopic(r);
    expect(t).not.toBeNull();
    expect(t!.tier).toBe(3);
  });

  it("the Hollow King wakes when a dwarf reaches Layer 6 depth", () => {
    const w = generateWorld({ seed: 201, width: 200, height: 2000 });
    const sim = new SimWorld(201, w.grid, w.surfaceY, w.spawn);
    expect(sim.hollowKingAware).toBe(false);
    // Drop a dwarf directly into the Underworld.
    sim.spawnDwarf({
      name: "Voidwalker",
      x: w.spawn.x,
      y: w.spawn.y + 1601,
      age: 30,
    });
    tick(sim);
    expect(sim.hollowKingAware).toBe(true);
    const awakening = sim.events.events.find((e) => e.text.includes("Something deep beneath"));
    expect(awakening).toBeDefined();
  });

  it("the King eventually sends void shades after enough nightmares", () => {
    const w = generateWorld({ seed: 207, width: 200, height: 2000 });
    const sim = new SimWorld(207, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Founder", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Skip the awakening flow and pin the threshold so the test runs
    // fast — we're testing the siege escalation, not the herald.
    sim.hollowKingAware = true;
    sim.hollowKingNightmares = 14;
    sim.hollowKingLastSiegeTick = sim.tick;
    // Carve a corridor deep enough that a shade has somewhere to spawn
    // — the spawner refuses tiles within the first 60 of the spawn
    // depth.
    for (let y = sim.spawn.y; y <= sim.spawn.y + 80; y++) {
      sim.grid.setTile(w.spawn.x, y, 7);
    }
    let shadeSpawned = false;
    for (let i = 0; i < 24 * 60 * 6 && !shadeSpawned; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      for (const h of sim.hostile.entities) {
        if (sim.hostile.get(h)?.kind === "void_shade") shadeSpawned = true;
      }
    }
    expect(shadeSpawned).toBe(true);
  });
});

describe("Hollow King nightmares", () => {
  it("cost the dreamer morale and unsettle the rest of the fortress", () => {
    const w = generateWorld({ seed: 61, width: 200, height: 500 });
    const sim = new SimWorld(61, w.grid, w.surfaceY, w.spawn);
    const dreamer = sim.spawnDwarf({ name: "Seer", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["void_sensitive"] });
    const other = sim.spawnDwarf({ name: "Sleeper", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.hollowKingAware = true;
    for (const id of [dreamer, other]) sim.needs.get(id)!.morale = 80;
    // Jump to the tick before a nightmare boundary (every 3 days).
    sim.tick = TICKS_PER_DAY * 3 - 1;
    tick(sim);
    expect(sim.hollowKingNightmares).toBe(1);
    const dm = sim.needs.get(dreamer)!.morale;
    const om = sim.needs.get(other)!.morale;
    expect(dm).toBeLessThan(om);
    expect(om).toBeLessThan(80);
  });
});
