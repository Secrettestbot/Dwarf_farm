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

  it("Iron Smelting is locked until the colony has mined ore", () => {
    const r = defaultResearch();
    // Without ore, the cumulative table is empty — Iron Smelting's
    // material gate fails. The selector skips it and picks something
    // that doesn't gate on materials.
    const noMaterial = nextTopic(r, { cumulative: {}, discovered: new Set() });
    expect(noMaterial?.id).not.toBe("iron_smelting");
    // Pre-seed everything except iron_smelting and iron_toolmaking
    // so iron_smelting is the cheapest still-unfinished Tier 1 topic.
    r.completed = [
      "basic_stonecutting", "basic_carpentry", "basic_cooking",
      "basic_brewing", "rope_and_fibre",
    ];
    // Without ore, the selector still skips iron_smelting and falls
    // through to Tier 2 topics whose prereqs are met (medical_practice,
    // masonry_and_mortaring, etc.). Iron Smelting is NOT picked.
    const stillLocked = nextTopic(r, { cumulative: {}, discovered: new Set() });
    expect(stillLocked?.id).not.toBe("iron_smelting");
    // Once 3 ore have been mined, the gate opens and iron_smelting
    // (cheaper than the Tier 2 alternatives at 800 vs 800-1100) wins
    // by alphabetical tiebreak vs. the rest.
    const withOre = nextTopic(r, { cumulative: { ore: 3 }, discovered: new Set() });
    expect(withOre?.id).toBe("iron_smelting");
  });

  it("Gem Cutting is locked until a gem vein is discovered", () => {
    const r = defaultResearch();
    r.completed = [
      "basic_stonecutting", "basic_carpentry", "basic_cooking",
      "basic_brewing", "rope_and_fibre", "iron_smelting",
      "iron_toolmaking", "masonry_and_mortaring", "carpentry_mechanisms",
      "armoury_basics", "medical_practice", "textile_craft",
      "underground_agriculture", "minecart_tracks", "pottery_and_kilns",
      "steel_alloying", "advanced_metallurgy", "weaponsmithing",
      "military_tactics", "fortification_design", "advanced_medicine",
    ];
    const ctx = {
      cumulative: { ore: 100, bars: 50, blocks: 50, dirt: 50, rope: 10 },
      discovered: new Set<number>(),
    };
    const without = nextTopic(r, ctx);
    expect(without?.id).not.toBe("gem_cutting");
    // Discover a ruby seam.
    const withGem = nextTopic(r, { ...ctx, discovered: new Set([22 /* RawRuby */]) });
    expect(withGem?.id).toBe("gem_cutting");
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
