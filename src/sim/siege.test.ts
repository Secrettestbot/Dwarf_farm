import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_YEAR, TICKS_PER_DAY } from "./time";

describe("siege system", () => {
  it("fires an outrider warning ~5 days before the warband arrives", () => {
    const w = generateWorld({ seed: 711, width: 200, height: 500 });
    const sim = new SimWorld(711, w.grid, w.surfaceY, w.spawn);
    // Spawn enough founders for the SIEGE_MIN_POPULATION gate.
    for (let i = 0; i < 12; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    // Year 1 + a week is enough to clear the schedule + lead + spawn.
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    // Find the warning and warband events anywhere in the log
    // (other events fire between them).
    const warning = sim.events.events.find((e) => e.text.includes("warband approaching"));
    const warband = sim.events.events.find((e) => e.text.includes("siege begins"));
    expect(warning).toBeDefined();
    expect(warband).toBeDefined();
    expect(warband!.tick).toBeGreaterThan(warning!.tick);
    // Should be at least 4 days between warning and warband (lead is 5).
    expect(warband!.tick - warning!.tick).toBeGreaterThanOrEqual(TICKS_PER_DAY * 4);
  });

  it("a colony below SIEGE_MIN_POPULATION (10) is never sieged", () => {
    const w = generateWorld({ seed: 713, width: 200, height: 500 });
    const sim = new SimWorld(713, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 7; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + i - 3, y: w.spawn.y, age: 30 });
    }
    // Block migration so the population stays under the siege gate
    // for the duration of the run. The siege check fires at year
    // boundaries; without lockdown a seven-dwarf colony would have
    // grown past 10 by then.
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    expect(sim.siegeActive).toBe(false);
    const sieged = sim.events.events.find((e) => e.text.includes("siege begins"));
    expect(sieged).toBeUndefined();
  });

  it("warband size scales with population", () => {
    function countGoblinsAfterArrival(pop: number): number {
      const w = generateWorld({ seed: 715, width: 200, height: 500 });
      const sim = new SimWorld(715, w.grid, w.surfaceY, w.spawn);
      for (let i = 0; i < pop; i++) {
        sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
      }
      for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
        for (const id of sim.dwarf.entities) {
          const n = sim.needs.get(id);
          if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
        }
        tick(sim);
        if (sim.siegeActive) break;
      }
      let goblins = 0;
      for (const id of sim.hostile.entities) {
        const h = sim.hostile.get(id);
        if (h?.kind === "goblin_scout") goblins++;
      }
      return goblins;
    }
    const small = countGoblinsAfterArrival(12);
    const large = countGoblinsAfterArrival(36);
    expect(large).toBeGreaterThan(small);
  });
});
