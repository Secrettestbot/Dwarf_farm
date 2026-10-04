// Gameplay effects of research topics that used to unlock nothing.
// Each test compares the researched vs unresearched behaviour of the
// system the topic modifies.

import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import {
  tick,
  craftResearchQualityBias,
  craftTicksResearchScale,
  deepMiningScale,
  roomMoraleBump,
} from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint, QUALITY_BASE } from "./planner/blueprint";
import { TICKS_PER_DAY } from "./time";
import { haulerCapForColony } from "./jobs/chooseTask";
import { siegeWithdrawTicks, voidMetallurgyBonus } from "./systems/hostiles";
import { hollowKingSystem, nightmareIntervalTicks, shadesPerSiege } from "./systems/hollowKing";

function freshSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  return new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
}

function pinNeeds(sim: SimWorld): void {
  for (const id of sim.dwarf.entities) {
    const n = sim.needs.get(id);
    if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
  }
}

/** Plant a complete room of `kind` beside spawn. */
function plantRoom(sim: SimWorld, kind: Blueprint["kind"], id: number): Blueprint {
  const ox = sim.spawn.x + 1;
  const oy = sim.spawn.y;
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 4; xx++) {
      cavity.push((yy << 16) | xx);
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  const bp: Blueprint = {
    id,
    kind,
    originX: ox,
    originY: oy,
    width: 4,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
    quality: QUALITY_BASE,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("research unlock effects", () => {
  it("minecart_tracks raises the hauler cap from 1-in-3 to 1-in-2", () => {
    const sim = freshSim(9001);
    for (let i = 0; i < 12; i++) sim.spawnDwarf({ name: `D${i}`, x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    expect(haulerCapForColony(sim)).toBe(4);
    sim.research.completed.push("minecart_tracks");
    expect(haulerCapForColony(sim)).toBe(6);
  });

  it("fortification_design makes a stalled warband withdraw after four days", () => {
    const sim = freshSim(5501);
    sim.spawnDwarf({ name: "D0", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    pinNeeds(sim);
    sim.research.completed.push("fortification_design");
    expect(siegeWithdrawTicks(sim)).toBe(TICKS_PER_DAY * 4);
    const gob = sim.spawnHostile({
      kind: "goblin_scout",
      x: sim.spawn.x,
      y: sim.surfaceY[sim.spawn.x],
      siegeMember: true,
    });
    sim.siegeActive = true;
    sim.siegeStartedAtTick = sim.tick;
    sim.tick += TICKS_PER_DAY * 4 - 2;
    tick(sim);
    expect(sim.siegeActive).toBe(true);
    tick(sim);
    expect(sim.siegeActive).toBe(false);
    expect(sim.ecs.isAlive(gob)).toBe(false);
    expect(sim.events.events.some((e) => e.text.includes("four days at the gate"))).toBe(true);
  });

  it("gem_inlay makes cut-gem engravings add more room quality", () => {
    const bumpFor = (researched: boolean): number => {
      const sim = freshSim(823);
      const room = plantRoom(sim, "dining_hall", 9300);
      if (researched) sim.research.completed.push("gem_inlay");
      sim.stockpile.cut_gems = 5;
      sim.stockpile.blocks = 0;
      sim.sliders.excavation = 0;
      sim.sliders.hauling = 0;
      sim.spawnDwarf({ name: "Jeweller", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
      for (let i = 0; i < 800; i++) {
        pinNeeds(sim);
        tick(sim);
        if ((room.decorationsCount ?? 0) >= 1) break;
      }
      expect(room.decorationsCount ?? 0).toBe(1);
      return (room.quality ?? 0) - QUALITY_BASE;
    };
    const plain = bumpFor(false);
    const inlaid = bumpFor(true);
    expect(inlaid - plain).toBe(6);
  });

  it("advanced_medicine speeds wound recovery", () => {
    const hpAfter = (researched: boolean): number => {
      const sim = freshSim(1);
      sim.spawnDwarf({ name: "Borin", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
      if (researched) sim.research.completed.push("advanced_medicine");
      const e = sim.dwarf.entities[0];
      sim.health.get(e)!.hp = 20;
      for (let i = 0; i < 300; i++) {
        pinNeeds(sim);
        tick(sim);
      }
      return sim.health.get(e)!.hp;
    };
    const plain = hpAfter(false);
    const treated = hpAfter(true);
    expect(plain).toBeGreaterThan(20);
    expect(treated).toBeGreaterThan(plain);
  });

  it("relic_analysis speeds research progress by 25%", () => {
    const progressAfter = (researched: boolean): number => {
      const sim = freshSim(101);
      const ox = sim.spawn.x + 2;
      const oy = sim.spawn.y;
      const cavity: number[] = [];
      for (let yy = oy; yy < oy + 3; yy++) {
        for (let xx = ox; xx < ox + 4; xx++) {
          sim.grid.setTile(xx, yy, TileType.CorridorFloor);
          cavity.push((yy << 16) | xx);
        }
      }
      sim.grid.setTile(ox + 1, oy, TileType.LibraryDesk);
      sim.planner.blueprints.push({
        id: 9200, kind: "library", originX: ox, originY: oy, width: 4, height: 3,
        cavity: new Int32Array(cavity), status: "complete", priority: 1, createdTick: 0,
      });
      for (let xx = sim.spawn.x; xx <= ox; xx++) sim.grid.setTile(xx, sim.spawn.y, TileType.CorridorFloor);
      sim.spawnDwarf({ name: "Scholar", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
      sim.dwarf.get(sim.dwarf.entities[0])!.skills.scholarship = 5;
      if (researched) sim.research.completed.push("relic_analysis");
      for (let i = 0; i < 200; i++) {
        pinNeeds(sim);
        tick(sim);
      }
      expect(sim.research.current).toBe("basic_brewing");
      return sim.research.progress;
    };
    const plain = progressAfter(false);
    const fast = progressAfter(true);
    expect(plain).toBeGreaterThan(0);
    expect(fast / plain).toBeGreaterThan(1.2);
    expect(fast / plain).toBeLessThan(1.3);
  });

  it("alchemy_basics slows need decay", () => {
    const thirstAfter = (researched: boolean): number => {
      const sim = freshSim(77);
      sim.spawnDwarf({ name: "Thirsty", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
      if (researched) sim.research.completed.push("alchemy_basics");
      pinNeeds(sim);
      for (let i = 0; i < 300; i++) tick(sim);
      return sim.needs.get(sim.dwarf.entities[0])!.thirst;
    };
    expect(thirstAfter(true)).toBeGreaterThan(thirstAfter(false));
  });

  it("deep_cartography widens each dwarf's reveal radius", () => {
    const seenAt8 = (researched: boolean): boolean => {
      const sim = freshSim(3131);
      const x = sim.spawn.x;
      const y = sim.spawn.y + 150;
      sim.spawnDwarf({ name: "Surveyor", x, y, age: 30 });
      if (researched) sim.research.completed.push("deep_cartography");
      tick(sim);
      const p = sim.position.get(sim.dwarf.entities[0])!;
      return sim.grid.isSeen(p.x, p.y + 8);
    };
    expect(seenAt8(false)).toBe(false);
    expect(seenAt8(true)).toBe(true);
  });

  it("magma_tapping speeds smelting; adamantite_smelting lifts all craft quality", () => {
    const sim = freshSim(1);
    expect(craftTicksResearchScale(sim, "smelter")).toBe(1);
    expect(craftResearchQualityBias(sim, "carpenter")).toBe(0);
    sim.research.completed.push("magma_tapping");
    expect(craftTicksResearchScale(sim, "smelter")).toBeLessThan(1);
    expect(craftTicksResearchScale(sim, "magma_forge")).toBeLessThan(1);
    expect(craftTicksResearchScale(sim, "carpenter")).toBe(1);
    sim.research.completed.push("adamantite_smelting");
    expect(craftResearchQualityBias(sim, "carpenter")).toBe(1);
    expect(craftResearchQualityBias(sim, "magma_forge")).toBe(2);
  });

  it("the_deep_breath speeds mining only at depth", () => {
    const sim = freshSim(1);
    const deepY = sim.spawn.y + 750;
    expect(deepMiningScale(sim, deepY)).toBe(1);
    sim.research.completed.push("the_deep_breath");
    expect(deepMiningScale(sim, deepY)).toBe(0.75);
    expect(deepMiningScale(sim, sim.spawn.y + 50)).toBe(1);
  });

  it("rune_inscription adds morale for resting in an engraved room", () => {
    const sim = freshSim(1);
    sim.spawnDwarf({ name: "Sleeper", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    const room = plantRoom(sim, "bedroom", 9400);
    const x = room.originX + 1;
    const y = room.originY + 1;
    room.decorationsCount = 1;
    expect(roomMoraleBump(sim, e, x, y, "bedroom")).toBe(0);
    sim.research.completed.push("rune_inscription");
    expect(roomMoraleBump(sim, e, x, y, "bedroom")).toBe(3);
    // An unengraved room gets nothing extra.
    room.decorationsCount = 0;
    expect(roomMoraleBump(sim, e, x, y, "bedroom")).toBe(0);
  });

  it("anchor_runes halves the Hollow King's nightmare rate", () => {
    const nightmaresIn12Days = (researched: boolean): number => {
      const sim = freshSim(1);
      sim.spawnDwarf({ name: "Dreamer", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
      sim.hollowKingAware = true;
      if (researched) sim.research.completed.push("anchor_runes");
      for (let t = 1; t <= TICKS_PER_DAY * 12; t++) {
        sim.tick = t;
        hollowKingSystem(sim);
      }
      return sim.hollowKingNightmares;
    };
    expect(nightmaresIn12Days(false)).toBe(4);
    expect(nightmaresIn12Days(true)).toBe(2);
    const sim = freshSim(1);
    const base = nightmareIntervalTicks(sim);
    sim.research.completed.push("anchor_runes");
    expect(nightmareIntervalTicks(sim)).toBe(base * 2);
  });

  it("void_engineering thins shade sieges; void_metallurgy hits void foes harder", () => {
    const sim = freshSim(1);
    expect(shadesPerSiege(sim)).toBe(3);
    expect(voidMetallurgyBonus(sim, "void_shade")).toBe(0);
    sim.research.completed.push("void_engineering", "void_metallurgy");
    expect(shadesPerSiege(sim)).toBe(2);
    expect(voidMetallurgyBonus(sim, "void_shade")).toBe(10);
    expect(voidMetallurgyBonus(sim, "hollow_king")).toBe(10);
    expect(voidMetallurgyBonus(sim, "goblin_scout")).toBe(0);
  });
});
