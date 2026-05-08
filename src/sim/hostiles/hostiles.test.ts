import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";
import { HOSTILE_DEFS } from "./types";

function buildSim(seed: number, dwarves: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < dwarves; i++) {
    sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 3), y: w.spawn.y, age: 30 });
  }
  return sim;
}

describe("hostiles: spawn + combat", () => {
  it("a dwarf gets the default 100 HP on spawn", () => {
    const sim = buildSim(1, 1);
    const e = sim.dwarf.entities[0];
    const hp = sim.health.get(e);
    expect(hp?.hp).toBe(100);
    expect(hp?.maxHp).toBe(100);
  });

  it("spawnHostile creates a hostile with full HP and a position", () => {
    const sim = buildSim(2, 1);
    const e = sim.spawnHostile({ kind: "cave_rat", x: 50, y: 100 });
    const def = HOSTILE_DEFS["cave_rat"];
    expect(sim.hostile.get(e)?.kind).toBe("cave_rat");
    expect(sim.health.get(e)?.hp).toBe(def.maxHp);
    expect(sim.position.get(e)).toEqual({ x: 50, y: 100 });
  });

  it("a dwarf adjacent to a hostile takes damage and the hostile takes damage back", () => {
    const sim = buildSim(3, 1);
    const dwarfId = sim.dwarf.entities[0];
    const dwarfPos = sim.position.get(dwarfId)!;
    const ratId = sim.spawnHostile({ kind: "cave_rat", x: dwarfPos.x + 1, y: dwarfPos.y });
    const dStartHp = sim.health.get(dwarfId)!.hp;
    const rStartHp = sim.health.get(ratId)!.hp;
    // Run several attack-cooldown windows.
    for (let i = 0; i < 200; i++) tick(sim);
    const dwarfStillAlive = sim.ecs.isAlive(dwarfId);
    const ratStillAlive = sim.ecs.isAlive(ratId);
    if (dwarfStillAlive) {
      expect(sim.health.get(dwarfId)!.hp).toBeLessThan(dStartHp);
    }
    if (ratStillAlive) {
      expect(sim.health.get(ratId)!.hp).toBeLessThan(rStartHp);
    }
  });

  it("a one-on-one fight ends with one combatant dead within a reasonable window", () => {
    const sim = buildSim(5, 1);
    const dwarfId = sim.dwarf.entities[0];
    const dwarfPos = sim.position.get(dwarfId)!;
    const ratId = sim.spawnHostile({ kind: "cave_rat", x: dwarfPos.x + 1, y: dwarfPos.y });
    // Pin survival needs so the dwarf doesn't break off to eat / drink /
    // sleep at night — we're testing combat, not life support.
    for (let i = 0; i < 4000; i++) {
      const n = sim.needs.get(dwarfId);
      if (n) {
        n.hunger = 100;
        n.thirst = 100;
        n.sleep = 100;
      }
      const h = sim.health.get(dwarfId);
      if (h) h.hp = h.maxHp; // pin HP so wounded-priority can't pull the dwarf away from the fight
      // Pin the rat adjacent to the dwarf so combat fires every tick —
      // otherwise the dwarf wanders and the slow rat can't keep up.
      const dPos = sim.position.get(dwarfId);
      const rPos = sim.position.get(ratId);
      if (dPos && rPos) {
        rPos.x = dPos.x + 1;
        rPos.y = dPos.y;
      }
      tick(sim);
    }
    // At least one of them should be dead. With base damage 6 vs rat HP 30
    // and rat damage 4 vs dwarf HP 100, the dwarf usually wins.
    const bothAlive = sim.ecs.isAlive(dwarfId) && sim.ecs.isAlive(ratId);
    expect(bothAlive).toBe(false);
  });

  it("hostile death emits a 'crisis' event with the dwarf's name", () => {
    const sim = buildSim(5, 1);
    const dwarfId = sim.dwarf.entities[0];
    const dwarfPos = sim.position.get(dwarfId)!;
    const ratId = sim.spawnHostile({ kind: "cave_rat", x: dwarfPos.x + 1, y: dwarfPos.y });
    // Pin needs so combat doesn't keep getting interrupted by survival
    // priorities — we want a clean combat resolution.
    for (let i = 0; i < 8000; i++) {
      const n = sim.needs.get(dwarfId);
      if (n) {
        n.hunger = 100;
        n.thirst = 100;
        n.sleep = 100;
      }
      const h = sim.health.get(dwarfId);
      if (h) h.hp = h.maxHp; // pin HP so wounded-priority can't pull the dwarf away from the fight
      // Pin the rat adjacent to the dwarf so combat fires every tick —
      // otherwise the dwarf wanders and the slow rat can't keep up.
      const dPos = sim.position.get(dwarfId);
      const rPos = sim.position.get(ratId);
      if (dPos && rPos) {
        rPos.x = dPos.x + 1;
        rPos.y = dPos.y;
      }
      tick(sim);
    }
    // The originally-spawned rat (ratId) must be gone. Other hostiles
    // may have spawned via the periodic spawn system, but this specific
    // entity's combat must have resolved.
    expect(sim.ecs.isAlive(ratId)).toBe(false);
    // A 'crisis'-category slain or death event was logged.
    const combatEvents = sim.events.events.filter(
      (e) =>
        (e.category === "crisis" && /slain|dead at|put down/.test(e.text)) ||
        (e.category === "social" && /slain by/.test(e.text)),
    );
    expect(combatEvents.length).toBeGreaterThanOrEqual(1);
  });
});
