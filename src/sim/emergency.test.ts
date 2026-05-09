import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { ALARM_DURATION_TICKS, ALARM_COOLDOWN_TICKS } from "./emergency";

describe("emergency buttons", () => {
  it("alarm auto-cancels after one in-game hour and writes a cooldown", () => {
    const w = generateWorld({ seed: 21, width: 200, height: 500 });
    const sim = new SimWorld(21, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.emergency.mode = "alarm";
    sim.emergency.startedAtTick = sim.tick;
    for (let i = 0; i < ALARM_DURATION_TICKS + 5; i++) tick(sim);
    expect(sim.emergency.mode).toBe("none");
    expect(sim.emergency.alarmCooldownUntil).toBeGreaterThan(sim.tick);
    expect(sim.emergency.alarmCooldownUntil - sim.tick).toBeLessThanOrEqual(ALARM_COOLDOWN_TICKS);
  });

  it("alarm overrides chooseTask — civilians take a shelter job", () => {
    const w = generateWorld({ seed: 23, width: 200, height: 500 });
    const sim = new SimWorld(23, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    // Pin needs so the choice isn't survival-driven.
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    sim.emergency.mode = "alarm";
    sim.emergency.startedAtTick = sim.tick;
    tick(sim);
    expect(sim.job.get(e)?.kind).toBe("shelter");
  });

  it("lockdown blocks immigrant arrivals", () => {
    const w = generateWorld({ seed: 27, width: 200, height: 500 });
    const sim = new SimWorld(27, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = sim.tick;
    const popBefore = sim.dwarf.size();
    // Run two in-game years' worth of seasons; lockdown means no migrants.
    for (let i = 0; i < 6 * 24 * 60; i++) {
      // Pin needs so the original dwarf doesn't die during the run.
      const n = sim.needs.get(sim.dwarf.entities[0]);
      if (n) {
        n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      }
      tick(sim);
    }
    // The only growth path during lockdown is births, and our test starts
    // with one unpaired dwarf — so the population stays at one.
    expect(sim.dwarf.size()).toBe(popBefore);
  });
});
