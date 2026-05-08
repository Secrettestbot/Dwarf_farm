import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_YEAR } from "./time";
import { TileType } from "./world/tiles";

describe("military squads", () => {
  it("the year-end draft picks the dwarves with the highest Military skill", () => {
    const w = generateWorld({ seed: 81, width: 200, height: 500 });
    const sim = new SimWorld(81, w.grid, w.surfaceY, w.spawn);
    // Spawn ten adults; give one of them a clear military edge.
    for (let i = 0; i < 10; i++) {
      const id = sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
      sim.dwarf.get(id)!.skills.military = i === 7 ? 12 : 1;
    }
    // Run one in-game year so draftSystem fires.
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) {
      // Pin needs so the dwarves don't starve before the year completes.
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) {
          n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
        }
      }
      tick(sim);
    }
    // 10% of 10 = 1 soldier. Should be the one with Military skill 12.
    expect(sim.squad.size()).toBe(1);
    const drafted = sim.squad.entities[0];
    expect(sim.dwarf.get(drafted)!.skills.military).toBe(12);
  });

  it("dwarves below the minimum military threshold aren't drafted", () => {
    const w = generateWorld({ seed: 83, width: 200, height: 500 });
    const sim = new SimWorld(83, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 5; i++) {
      const id = sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
      sim.dwarf.get(id)!.skills.military = 1;
    }
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    expect(sim.squad.size()).toBe(0);
  });

  it("a soldier engages a nearby hostile instead of taking civilian work", () => {
    const w = generateWorld({ seed: 87, width: 200, height: 500 });
    const sim = new SimWorld(87, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({ name: "Guard", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.military = 10;
    // Hand-draft (skip the year-boundary delay) so the test isolates
    // engagement behaviour.
    sim.squad.set(id, { draftedAtTick: 0 });
    // Pin needs so the soldier doesn't divert to drink.
    const n = sim.needs.get(id)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    // Drop a hostile a couple of tiles away.
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 3, y: w.spawn.y });
    tick(sim);
    const job = sim.job.get(id);
    expect(job?.kind).toBe("engage");
  });

  it("the year-end draft equips a recruit from the global tools counter", () => {
    const w = generateWorld({ seed: 91, width: 200, height: 500 });
    const sim = new SimWorld(91, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({ name: "Recruit", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.military = 12;
    sim.stockpile.tools = 5;
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.squad.has(id)).toBe(true);
    expect(sim.equipment.get(id)?.weapon).toBe(true);
    expect(sim.stockpile.tools).toBe(4);
  });

  it("a recruit at draft time with no tools available stays unarmed", () => {
    const w = generateWorld({ seed: 93, width: 200, height: 500 });
    const sim = new SimWorld(93, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({ name: "Recruit", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.military = 12;
    sim.stockpile.tools = 0;
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.squad.has(id)).toBe(true);
    expect(sim.equipment.has(id)).toBe(false);
  });

  it("a tool sitting on an Armoury rack equips a recruit before the global counter is touched", () => {
    const w = generateWorld({ seed: 95, width: 200, height: 500 });
    const sim = new SimWorld(95, w.grid, w.surfaceY, w.spawn);
    // Carve an armoury cavity with one rack tile.
    const ax = w.spawn.x + 2;
    const ay = w.spawn.y;
    sim.grid.setTile(ax, ay, TileType.ArmouryRack);
    const cavity = new Int32Array([(ay << 16) | ax]);
    sim.planner.blueprints.push({
      id: 9300,
      kind: "armoury",
      originX: ax,
      originY: ay,
      width: 1,
      height: 1,
      cavity,
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Drop a tool on the rack and a counter pool too — the rack should
    // be drawn from first.
    sim.spawnItem({ kind: "tools", x: ax, y: ay });
    sim.stockpile.tools = 5;
    const id = sim.spawnDwarf({ name: "Recruit", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.military = 12;
    for (let i = 0; i < TICKS_PER_YEAR + 5; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.equipment.get(id)?.weapon).toBe(true);
    // The rack tool was consumed (no item left at the rack).
    let toolsAtRack = 0;
    for (const ie of sim.item.entities) {
      const it = sim.item.get(ie);
      const p = sim.position.get(ie);
      if (it?.kind === "tools" && p?.x === ax && p?.y === ay) toolsAtRack++;
    }
    expect(toolsAtRack).toBe(0);
    // The counter is untouched — five tools still in reserve.
    expect(sim.stockpile.tools).toBe(5);
  });

  it("a civilian under Alarm shelters; a soldier under Alarm engages", () => {
    const w = generateWorld({ seed: 89, width: 200, height: 500 });
    const sim = new SimWorld(89, w.grid, w.surfaceY, w.spawn);
    const civ = sim.spawnDwarf({ name: "Civ", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const sol = sim.spawnDwarf({ name: "Sol", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.squad.set(sol, { draftedAtTick: 0 });
    sim.spawnHostile({ kind: "cave_rat", x: w.spawn.x + 3, y: w.spawn.y });
    sim.emergency.mode = "alarm";
    sim.emergency.startedAtTick = 0;
    for (const id of sim.dwarf.entities) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
    }
    tick(sim);
    expect(sim.job.get(civ)?.kind).toBe("shelter");
    expect(sim.job.get(sol)?.kind).toBe("engage");
  });
});
