import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { TICKS_PER_DAY, TICKS_PER_SEASON } from "./time";
import {
  beginSiegeMorale, siegeMorale, siegeMoraleCheck, siegeMoraleRate,
  MORALE_DECAY_PER_DAY, WINTER_DECAY_FACTOR, LOSS_PENALTY_TOTAL, PLUNDER_BONUS,
} from "./systems/siegeMorale";
import { snapshot, restore } from "../save/snapshot";
import { tick } from "./sim";

function besieged(seed: number, size: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.siegeActive = true;
  sim.siegeStartedAtTick = sim.tick;
  beginSiegeMorale(sim, size);
  return sim;
}

describe("warband morale", () => {
  it("drains with time, faster in winter", () => {
    const sim = besieged(61, 10);
    expect(siegeMorale(sim)).toBe(100);
    sim.tick += TICKS_PER_DAY * 2;
    expect(siegeMorale(sim)).toBeCloseTo(100 - 2 * MORALE_DECAY_PER_DAY);
    sim.tick = TICKS_PER_SEASON * 3 + 1; // winter
    expect(siegeMoraleRate(sim)).toBeCloseTo(MORALE_DECAY_PER_DAY * WINTER_DECAY_FACTOR);
  });

  it("losses at the gate break it sooner; kills embolden it", () => {
    const sim = besieged(63, 10);
    sim.siegeGoblinsLost = 5;
    expect(siegeMorale(sim)).toBeCloseTo(100 - LOSS_PENALTY_TOTAL / 2);
    sim.siegeDwarvesSlain = 2;
    expect(siegeMorale(sim)).toBeCloseTo(100 - LOSS_PENALTY_TOTAL / 2 + 2 * PLUNDER_BONUS);
  });

  it("chronicles the warband wavering, once per beat, and reports the break", () => {
    const sim = besieged(65, 10);
    sim.tick += TICKS_PER_DAY * 3; // morale 55
    expect(siegeMoraleCheck(sim)).toBe(false);
    expect(siegeMoraleCheck(sim)).toBe(false);
    expect(sim.events.events.filter((e) => /growing restless/.test(e.text))).toHaveLength(1);
    sim.tick += TICKS_PER_DAY * 4; // morale -5
    expect(siegeMoraleCheck(sim)).toBe(true);
    expect(sim.events.events.some((e) => /wavering/.test(e.text))).toBe(true);
  });

  it("survives a save round-trip", () => {
    const sim = besieged(67, 8);
    sim.spawnHostile({ kind: "goblin_scout", x: 10, y: 10, siegeMember: true });
    sim.siegeGoblinsLost = 3;
    sim.siegeDwarvesSlain = 1;
    sim.tick += TICKS_PER_DAY * 3;
    const before = siegeMorale(sim);
    const save = snapshot({ sim, slotId: "slot0", fortressName: "M", mode: "legacy", cameraX: 0, cameraY: 0, zoomIndex: 1 });
    const back = restore(save);
    expect(siegeMorale(back)).toBeCloseTo(before);
    expect(back.siegeMoraleBeat).toBe(1);
  });

  it("hiding from a siege wears on the colony's morale", () => {
    const run = (hide: boolean) => {
      const sim = besieged(69, 6);
      const e = sim.spawnDwarf({ name: "Hider", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
      if (hide) sim.emergency.mode = "evacuate";
      for (let i = 0; i < TICKS_PER_DAY * 2; i++) {
        const n = sim.needs.get(e)!;
        n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
        tick(sim);
      }
      return sim.needs.get(e)!.morale;
    };
    expect(run(true)).toBeLessThan(run(false) - 15);
  });
});
