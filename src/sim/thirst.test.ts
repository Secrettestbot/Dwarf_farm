import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_DAY } from "./time";

describe("colony survives thirst", () => {
  it("a fresh founder colony lives 6 in-game months without dying of thirst", () => {
    // Regression for "the dwarves keep dying of thirst": the brewery
    // scaling cap (one brewery total, regardless of population) and a
    // tight starter cache let a post-migration colony of 25+ dwarves
    // run dry while the lone brewer couldn't keep up. The fix adds
    // brewery scaling per population and bumps the starter caches.
    const w = generateWorld({ seed: 31, width: 200, height: 500 });
    // Bump max entities — six in-game months of full production
    // spawns more drink/meal/bar items than the 4096 default allows.
    const sim = new SimWorld(31, w.grid, w.surfaceY, w.spawn, 16384);
    for (let i = 0; i < 7; i++) {
      sim.spawnDwarf({ name: `Founder${i}`, x: w.spawn.x + (i % 3) - 1, y: w.spawn.y, age: 25 + i });
    }
    let lowestDrink = sim.stockpile.drink;
    for (let day = 0; day < 180; day++) {
      for (let t = 0; t < TICKS_PER_DAY; t++) tick(sim);
      lowestDrink = Math.min(lowestDrink, sim.stockpile.drink);
    }
    const dehydrationDeaths = sim.events.events.filter((e) => /dehydration|of thirst|parched/i.test(e.text)).length;
    {
      const brewComplete = sim.planner.blueprints.filter((b) => b.kind === "brewery" && b.status === "complete").length;
      const farmComplete = sim.planner.blueprints.filter((b) => b.kind === "farm" && b.status === "complete").length;
      const libComplete = sim.planner.blueprints.filter((b) => b.kind === "library" && b.status === "complete").length;
      const starvations = sim.events.events.filter((e) => /starvation|of hunger|starved/i.test(e.text)).length;
      const violentDeaths = sim.events.events.filter((e) => /slain|gored|torn|crushed|struck dead/i.test(e.text)).length;
      // eslint-disable-next-line no-console
      console.log(`pop=${sim.dwarf.entities.length} drink=${sim.stockpile.drink} food=${sim.stockpile.food} lowest_drink=${lowestDrink} dehydrations=${dehydrationDeaths} starvations=${starvations} violent=${violentDeaths} breweries=${brewComplete} farms=${farmComplete} libs=${libComplete} basic_brewing_done=${sim.research.completed.includes("basic_brewing")}`);
    }
    expect(dehydrationDeaths).toBe(0);
    expect(sim.dwarf.entities.length).toBeGreaterThan(0);
    // Drink supply should never run dry — there should always be a
    // visible buffer thanks to brewery scaling + starter cache.
    expect(lowestDrink).toBeGreaterThan(0);
  });
});
