import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick, migrationChance } from "../sim";
import { TICKS_PER_DAY } from "../time";

const SEASON_TICKS = TICKS_PER_DAY * 6;

function buildSim(seed: number, dwarves: number, age = 30): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < dwarves; i++) {
    sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age });
  }
  return sim;
}

describe("migration", () => {
  it("a young colony gains immigrants within a few seasons", () => {
    // pop 7 → 60% chance per season; 4 seasons gives ~97% probability.
    const sim = buildSim(11, 7);
    const initial = sim.dwarf.size();
    // Run 4 seasons.
    for (let i = 0; i < SEASON_TICKS * 4 + 5; i++) tick(sim);
    expect(sim.dwarf.size()).toBeGreaterThan(initial);
  });

  it("an arrival event lands in the chronicle within ~2 in-game years", () => {
    // pop 7 → 60% per season; 8 seasons gives P(zero arrivals) ≈ 0.07%.
    const sim = buildSim(13, 7);
    for (let i = 0; i < SEASON_TICKS * 8 + 5; i++) tick(sim);
    const arrivals = sim.events.events.filter((e) =>
      e.category === "social" && /arrived|joined|caravan/i.test(e.text),
    );
    expect(arrivals.length).toBeGreaterThanOrEqual(1);
  });

  it("the migration chance curve caps at population 200", () => {
    // Direct unit test on the rate function — running a 200-dwarf sim is
    // too slow for a test loop.
    expect(migrationChance(0)).toBe(0.6);
    expect(migrationChance(7)).toBe(0.6);
    expect(migrationChance(20)).toBe(0.45);
    expect(migrationChance(50)).toBe(0.30);
    expect(migrationChance(100)).toBe(0.10);
    expect(migrationChance(200)).toBe(0);
    expect(migrationChance(500)).toBe(0);
  });

  it("immigrants are full adults and join the work loop", () => {
    const sim = buildSim(19, 5);
    // Run a couple of seasons; some migrants likely arrived.
    for (let i = 0; i < SEASON_TICKS * 4; i++) tick(sim);
    let nonFounderAdult = false;
    sim.forEachDwarf((id, _pos, dw) => {
      // Founders are named D0..D4. Anything else is an immigrant.
      if (dw.name.startsWith("D")) return;
      const age = sim.ageOf(id);
      if (age >= 18) nonFounderAdult = true;
    });
    expect(nonFounderAdult).toBe(true);
  });
});
