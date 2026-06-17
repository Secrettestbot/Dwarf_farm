import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

/** Plant a complete kitchen with one station tile near spawn so
 * the cook has somewhere to work. Returns the blueprint. */
function plantKitchen(sim: SimWorld): Blueprint {
  const ox = sim.spawn.x + 1;
  const oy = sim.spawn.y;
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      cavity.push((yy << 16) | xx);
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  // Centre tile gets the kitchen station so progressCraft fires.
  sim.grid.setTile(ox + 1, oy + 1, TileType.KitchenStation);
  const bp: Blueprint = {
    id: 9301,
    kind: "kitchen",
    originX: ox,
    originY: oy,
    width: 3,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

/** Count meal entities currently on the world floor. Kitchen
 * output spawns "meal" items at the station tile; haulers move
 * them to the stockpile counter. Tests with hauling disabled need
 * to read item entities directly. */
function countMealItems(sim: SimWorld): number {
  let n = 0;
  for (const ie of sim.item.entities) {
    const it = sim.item.get(ie);
    if (it?.kind === "meal") n++;
  }
  return n;
}

describe("kitchen cooking depth", () => {
  it("kitchen runs the basic recipe (1 food → 2 meal items) when drink is scarce", () => {
    const w = generateWorld({ seed: 901, width: 200, height: 500 });
    const sim = new SimWorld(901, w.grid, w.surfaceY, w.spawn);
    plantKitchen(sim);
    sim.stockpile.food = 50;
    sim.stockpile.drink = 0; // stew gate fails
    sim.stockpile.cut_gems = 0; // feast gate fails
    // Block hauling + migration so the test sees a single craft
    // cycle cleanly without haulers moving the output away or
    // migrants eating into the food pile.
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    sim.spawnDwarf({ name: "Cook", x: sim.spawn.x, y: sim.spawn.y, age: 30, skills: { cooking: 5 } });
    const id = sim.dwarf.entities[0];
    const foodBefore = sim.stockpile.food;
    const mealsItemsBefore = countMealItems(sim);
    for (let i = 0; i < 800; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (countMealItems(sim) > mealsItemsBefore) break;
    }
    const mealsItemsAfter = countMealItems(sim);
    expect(mealsItemsAfter - mealsItemsBefore).toBeGreaterThanOrEqual(2);
    // Basic recipe: 1 food consumed per cycle. The break above caps
    // at the first cycle, so exactly 1 food consumed.
    expect(foodBefore - sim.stockpile.food).toBe(1);
    expect(sim.stockpile.drink).toBe(0);
  });

  it("kitchen runs the stew recipe (2 food + 1 drink → 5 meals) when drink is flush", () => {
    const w = generateWorld({ seed: 903, width: 200, height: 500 });
    const sim = new SimWorld(903, w.grid, w.surfaceY, w.spawn);
    plantKitchen(sim);
    sim.stockpile.food = 50;
    sim.stockpile.drink = 100; // well above the 30-unit gate
    sim.stockpile.cut_gems = 0;
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    sim.spawnDwarf({ name: "Cook", x: sim.spawn.x, y: sim.spawn.y, age: 30, skills: { cooking: 5 } });
    const id = sim.dwarf.entities[0];
    const foodBefore = sim.stockpile.food;
    const drinkBefore = sim.stockpile.drink;
    const initialMeals = countMealItems(sim);
    for (let i = 0; i < 800; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (countMealItems(sim) >= initialMeals + 5) break;
    }
    expect(foodBefore - sim.stockpile.food).toBe(2);
    expect(drinkBefore - sim.stockpile.drink).toBe(1);
    expect(countMealItems(sim)).toBeGreaterThanOrEqual(5);
  });

  it("a started craft finishes on the recipe it began with, even if the stockpile crosses a swap threshold mid-craft", () => {
    // Regression: progressCraft used to re-evaluate the kitchen
    // swap on every tick, so a stew that started with drink ≥ 31
    // could ship basic-meal outputs (2 meals) after the brewery
    // drained drink below the gate — paying the stew tax for a
    // basic deal.
    const w = generateWorld({ seed: 907, width: 200, height: 500 });
    const sim = new SimWorld(907, w.grid, w.surfaceY, w.spawn);
    plantKitchen(sim);
    sim.stockpile.food = 50;
    sim.stockpile.drink = 100; // above the 31-unit stew gate
    sim.stockpile.cut_gems = 0;
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    sim.spawnDwarf({ name: "Cook", x: sim.spawn.x, y: sim.spawn.y, age: 30, skills: { cooking: 5 } });
    const id = sim.dwarf.entities[0];
    const initialMeals = countMealItems(sim);
    // Run until the craft picks up its recipe (job.recipeKey set).
    let started = false;
    for (let i = 0; i < 200 && !started; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      const job = sim.job.get(id);
      if (job?.kind === "craft" && job.recipeKey === "kitchen.stew") started = true;
    }
    expect(started).toBe(true);
    // Now drain drink below the gate. The next tick's swap chain
    // would otherwise reclassify the kitchen as basic.
    sim.stockpile.drink = 5;
    // Run to completion of the started stew.
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (countMealItems(sim) >= initialMeals + 5) break;
    }
    // Stew output is 5 meals — basic would be only 2.
    expect(countMealItems(sim) - initialMeals).toBeGreaterThanOrEqual(5);
  });

  it("kitchen runs the noble feast (food + cut gem → 6 meals) when cut_gems are surplus", () => {
    const w = generateWorld({ seed: 905, width: 200, height: 500 });
    const sim = new SimWorld(905, w.grid, w.surfaceY, w.spawn);
    plantKitchen(sim);
    sim.stockpile.food = 50;
    sim.stockpile.drink = 0; // stew gate fails (drink scarce)
    sim.stockpile.cut_gems = 10; // feast gate passes
    sim.sliders.excavation = 0;
    sim.sliders.hauling = 0;
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    sim.spawnDwarf({ name: "Cook", x: sim.spawn.x, y: sim.spawn.y, age: 30, skills: { cooking: 5 } });
    const id = sim.dwarf.entities[0];
    const foodBefore = sim.stockpile.food;
    const gemsBefore = sim.stockpile.cut_gems;
    const initialMeals = countMealItems(sim);
    for (let i = 0; i < 1000; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (countMealItems(sim) >= initialMeals + 6) break;
    }
    expect(foodBefore - sim.stockpile.food).toBe(2);
    expect(gemsBefore - sim.stockpile.cut_gems).toBe(1);
    expect(countMealItems(sim)).toBeGreaterThanOrEqual(6);
  });
});
