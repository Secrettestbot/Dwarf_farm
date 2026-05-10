import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";
import { TICKS_PER_YEAR } from "../time";

function buildSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 25 });
  return sim;
}

describe("dwarf aging", () => {
  it("reports the spawn age immediately after spawn", () => {
    const sim = buildSim(1);
    const e = sim.dwarf.entities[0];
    expect(sim.ageOf(e)).toBe(25);
  });

  it("ages by one year after TICKS_PER_YEAR ticks elapse", () => {
    const sim = buildSim(2);
    const e = sim.dwarf.entities[0];
    // Pin needs each tick — without this Borin can starve / dehydrate
    // mid-loop, freeing his entity slot for a migrant. The slot-reuse
    // makes ageOf(e) report the migrant's age, which has nothing to
    // do with what the test is measuring (calendar-driven aging).
    // The need-pin is what every other long-running aging test does
    // for the same reason.
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.ageOf(e)).toBe(26);
  });

  it("ages multiple years correctly", () => {
    const sim = buildSim(3);
    const e = sim.dwarf.entities[0];
    // Pin Borin's needs each tick — at 3 in-game years he'd otherwise die
    // of thirst long before the loop ends, the entity slot would be reused
    // by a migrant via the ECS free list, and `ageOf(e)` would report the
    // migrant's age. The test is about calendar-driven aging, not survival.
    for (let i = 0; i < TICKS_PER_YEAR * 3 + 10; i++) {
      const n = sim.needs.get(e);
      if (n) {
        n.hunger = 100;
        n.thirst = 100;
        n.sleep = 100;
        n.social = 100;
      }
      // Also pin HP — over three years, RNG-driven hostile spawns can
      // catch Borin in a fight regardless of needs. The test is about
      // calendar-driven aging, not survival.
      const hp = sim.health.get(e);
      if (hp) {
        hp.hp = hp.maxHp;
        hp.lastAttackTick = 0;
      }
      tick(sim);
    }
    expect(sim.ageOf(e)).toBe(28);
  });

  it("emits a milestone event each new in-game year", () => {
    const sim = buildSim(4);
    for (let i = 0; i < TICKS_PER_YEAR * 2 + 5; i++) tick(sim);
    // Filter to year-rollover entries specifically — other milestone
    // categories (skill tier crossings, population thresholds) may also
    // fire during this run.
    const yearEvents = sim.events.events.filter(
      (e) => e.category === "milestone" && e.text.includes("Year"),
    );
    expect(yearEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("does not emit a year event before the first year completes", () => {
    const sim = buildSim(5);
    for (let i = 0; i < TICKS_PER_YEAR - 60; i++) tick(sim);
    const yearEvents = sim.events.events.filter(
      (e) => e.category === "milestone" && e.text.includes("Year"),
    );
    expect(yearEvents.length).toBe(0);
  });
});

describe("dwarfAt hit-test", () => {
  it("finds the dwarf at their exact position", () => {
    const sim = buildSim(7);
    const e = sim.dwarf.entities[0];
    const pos = sim.position.get(e)!;
    expect(sim.dwarfAt(pos.x, pos.y)).toBe(e);
  });

  it("returns null on an empty tile", () => {
    const sim = buildSim(8);
    expect(sim.dwarfAt(0, 0)).toBeNull();
  });
});
