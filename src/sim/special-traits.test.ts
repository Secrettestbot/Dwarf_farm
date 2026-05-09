import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

describe("special traits (GDD §6.5)", () => {
  it("Stone-Speaker writes a seasonal vision of a nearby unseen ore vein", () => {
    const w = generateWorld({ seed: 911, width: 200, height: 500 });
    const sim = new SimWorld(911, w.grid, w.surfaceY, w.spawn);
    // Plant an unmined ore tile within range, leave it unseen (no
    // dwarf reveals it before the seasonal tick fires).
    sim.grid.setTile(w.spawn.x + 50, w.spawn.y + 30, TileType.Ore);
    sim.spawnDwarf({
      name: "Geode",
      x: w.spawn.x,
      y: w.spawn.y,
      age: 30,
      traitIds: ["stone_speaker"],
    });
    const e = sim.dwarf.entities[0];
    // Run just over a season (24 days × 6 = 144 days... actually a
    // season is 6 days). Run 7 days to be sure the seasonal tick
    // fires.
    for (let i = 0; i < 24 * 60 * 7; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    const vision = sim.events.events.find((e) => e.text.includes("closes their eyes"));
    expect(vision).toBeDefined();
  });

  it("Stone-Speaker stays silent if there's nothing unseen in range", () => {
    const w = generateWorld({ seed: 913, width: 200, height: 500 });
    const sim = new SimWorld(913, w.grid, w.surfaceY, w.spawn);
    // Reveal the entire reachable area so no unseen ore is left.
    for (let y = 0; y < w.grid.height; y++) {
      for (let x = 0; x < w.grid.width; x++) w.grid.markSeen(x, y);
    }
    sim.spawnDwarf({
      name: "Geode",
      x: w.spawn.x,
      y: w.spawn.y,
      age: 30,
      traitIds: ["stone_speaker"],
    });
    for (let i = 0; i < 24 * 60 * 7; i++) {
      const n = sim.needs.get(sim.dwarf.entities[0]);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    const vision = sim.events.events.find((e) => e.text.includes("closes their eyes"));
    expect(vision).toBeUndefined();
  });

  it("Ancestor's Voice writes a weekly piece of advice", () => {
    const w = generateWorld({ seed: 915, width: 200, height: 500 });
    const sim = new SimWorld(915, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({
      name: "Listener",
      x: w.spawn.x,
      y: w.spawn.y,
      age: 30,
      traitIds: ["ancestors_voice"],
    });
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 24 * 60 * 8; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    const advice = sim.events.events.find((e) => e.text.includes("grandmother's voice"));
    expect(advice).toBeDefined();
  });

  it("The Fury triggers when a bonded dwarf is slain in combat", () => {
    const w = generateWorld({ seed: 917, width: 200, height: 500 });
    const sim = new SimWorld(917, w.grid, w.surfaceY, w.spawn);
    const a = sim.spawnDwarf({
      name: "Avenger",
      x: w.spawn.x,
      y: w.spawn.y,
      age: 30,
      traitIds: ["the_fury"],
    });
    const b = sim.spawnDwarf({
      name: "Bonded",
      x: w.spawn.x + 1,
      y: w.spawn.y,
      age: 30,
    });
    sim.dwarf.get(a)!.partnerId = b;
    sim.dwarf.get(b)!.partnerId = a;
    // Spawn a hostile adjacent to the partner and pin its attack so
    // it kills the partner this tick.
    sim.spawnHostile({ kind: "cave_troll", x: w.spawn.x + 2, y: w.spawn.y });
    const hEnt = sim.hostile.entities[0];
    sim.health.set(hEnt, { hp: 200, maxHp: 200, lastAttackTick: -1000 });
    // Pin the partner at low HP so the troll's blow lands fatal.
    sim.health.set(b, { hp: 1, maxHp: 100, lastAttackTick: -1000 });
    sim.health.set(a, { hp: 200, maxHp: 200, lastAttackTick: -1000 });
    // Force the cave troll's last-move-tick stale so it strikes
    // immediately, and pin needs.
    sim.hostile.get(hEnt)!.lastAttackTick = -1000;
    sim.hostile.get(hEnt)!.lastMoveTick = -1000;
    for (let i = 0; i < 60 && !sim.fury.has(a); i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      // Keep hostile HP high so combat keeps grinding until the
      // partner's HP runs out.
      const hp = sim.health.get(hEnt);
      if (hp && hp.hp < 100) hp.hp = 200;
      tick(sim);
    }
    expect(sim.fury.has(a)).toBe(true);
  });
});
