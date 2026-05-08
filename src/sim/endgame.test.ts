import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TIER_5_TOPICS, TIER_6_TOPICS, TOPICS_BY_ID, nextTopic, defaultResearch } from "./research";

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
      "underground_agriculture", "minecart_tracks",
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
});
