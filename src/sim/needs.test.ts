import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

function buildSim(seed: number, dwarves = 1): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < dwarves; i++) {
    sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
  }
  return sim;
}

describe("hunger and thirst needs", () => {
  it("dwarves spawn at full hunger and thirst", () => {
    const sim = buildSim(1);
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    expect(n.hunger).toBe(100);
    expect(n.thirst).toBe(100);
  });

  it("hunger and thirst decay over time", () => {
    const sim = buildSim(2);
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    n.hunger = 80;
    n.thirst = 80;
    // Run 600 ticks. Thirst at 1/15 → ~40 down. Hunger at 1/30 → ~20 down.
    for (let i = 0; i < 600; i++) tick(sim);
    expect(n.hunger).toBeLessThan(80);
    expect(n.thirst).toBeLessThan(80);
    // Thirst decays faster than hunger.
    const hungerDelta = 80 - n.hunger;
    const thirstDelta = 80 - n.thirst;
    expect(thirstDelta).toBeGreaterThan(hungerDelta);
  });

  it("a critically thirsty dwarf with stockpile drink picks a 'drink' job", () => {
    const sim = buildSim(3);
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    n.thirst = 20;
    n.hunger = 100; // not hungry, so drink wins
    n.sleep = 100;
    // Run a few ticks for chooseTask to fire.
    for (let i = 0; i < 10; i++) tick(sim);
    const job = sim.job.get(e);
    expect(job?.kind).toBe("drink");
  });

  it("eating consumes a food unit and restores hunger", () => {
    const sim = buildSim(4);
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    n.hunger = 25;
    n.thirst = 100;
    n.sleep = 100;
    const startFood = sim.stockpile.food;
    // Long enough for the eat job to fire and progress.
    for (let i = 0; i < 80; i++) tick(sim);
    expect(sim.stockpile.food).toBeLessThan(startFood);
    expect(sim.needs.get(e)!.hunger).toBeGreaterThan(25);
  });

  it("a dwarf with no thirst dies of dehydration", () => {
    const sim = buildSim(5);
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    // Manually drain thirst — also empty the stockpile so they can't drink.
    n.thirst = 1;
    sim.stockpile.drink = 0;
    // One decay tick interval is enough.
    for (let i = 0; i < 30; i++) tick(sim);
    expect(sim.ecs.isAlive(e)).toBe(false);
    const dehydration = sim.events.events.find((ev) => /dehydration/i.test(ev.text));
    expect(dehydration).toBeDefined();
  });

  it("a dwarf with no hunger dies of starvation", () => {
    const sim = buildSim(7);
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    n.hunger = 1;
    sim.stockpile.food = 0;
    n.thirst = 100;
    for (let i = 0; i < 60; i++) tick(sim);
    expect(sim.ecs.isAlive(e)).toBe(false);
    const starvation = sim.events.events.find((ev) => /starvation/i.test(ev.text));
    expect(starvation).toBeDefined();
  });
});
