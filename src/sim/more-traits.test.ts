import { describe, it, expect } from "vitest";
import { effectsFor } from "./dwarves/traitEffects";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

describe("more wired traits (GDD §6.5)", () => {
  it("Strong and Slight scale workSpeed in opposite directions", () => {
    expect(effectsFor(["strong"]).workSpeed).toBeCloseTo(1.10);
    expect(effectsFor(["slight"]).workSpeed).toBeCloseTo(0.85);
  });

  it("Loyal/Fickle change the bereavement morale scale", () => {
    expect(effectsFor(["loyal"]).bereavementScale).toBe(2);
    expect(effectsFor(["fickle"]).bereavementScale).toBe(0.25);
  });

  it("Eagle-Eyed gets a wider visibility radius", () => {
    expect(effectsFor(["eagle_eyed"]).visibilityRadius).toBe(8);
    expect(effectsFor([]).visibilityRadius).toBe(5);
  });

  it("a Loyal partner takes a real morale hit when their bond dies", () => {
    const w = generateWorld({ seed: 1201, width: 200, height: 500 });
    const sim = new SimWorld(1201, w.grid, w.surfaceY, w.spawn);
    const a = sim.spawnDwarf({ name: "A", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["loyal"] });
    const b = sim.spawnDwarf({ name: "B", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.dwarf.get(a)!.partnerId = b;
    sim.dwarf.get(b)!.partnerId = a;
    const aNeeds = sim.needs.get(a)!;
    aNeeds.morale = 80;
    // Force B to starve (kills via needsSystem with a non-violent
    // cause — bereavement still fires).
    const bNeeds = sim.needs.get(b)!;
    bNeeds.thirst = 0;
    tick(sim);
    // Loyal: hit = 15 * 2 = 30. Morale should drop ~30 from 80.
    expect(sim.needs.get(a)!.morale).toBeLessThanOrEqual(60);
  });

  it("an Eagle-Eyed dwarf reveals a wider radius than a default one", () => {
    const w = generateWorld({ seed: 1203, width: 200, height: 500 });
    const sim = new SimWorld(1203, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Scout", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["eagle_eyed"] });
    tick(sim);
    // The default radius is 5; Eagle-Eyed sees out to 8. So a tile
    // 7 away should be marked seen for the Eagle-Eyed dwarf only.
    expect(sim.grid.isSeen(w.spawn.x + 7, w.spawn.y)).toBe(true);
  });

  it("Agile/Slow scale moveSpeed; Proud/Humble scale roomQualityScale", () => {
    expect(effectsFor(["agile"]).moveSpeed).toBeCloseTo(1.20);
    expect(effectsFor(["slow"]).moveSpeed).toBeCloseTo(0.80);
    expect(effectsFor(["proud"]).roomQualityScale).toBe(2);
    expect(effectsFor(["humble"]).roomQualityScale).toBe(0.25);
  });

  it("a Natural Leader bumps the morale of nearby dwarves", () => {
    const w = generateWorld({ seed: 1205, width: 200, height: 500 });
    const sim = new SimWorld(1205, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Captain", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["natural_leader"] });
    sim.spawnDwarf({ name: "Soldier", x: w.spawn.x + 2, y: w.spawn.y, age: 30 });
    const soldier = sim.dwarf.entities[1];
    sim.needs.get(soldier)!.morale = 50;
    // Run an in-game hour so the passive aura fires.
    for (let i = 0; i < 60; i++) tick(sim);
    expect(sim.needs.get(soldier)!.morale).toBeGreaterThan(50);
  });

  it("Phobia: Deep Rock saps morale when the dwarf is below depth 300", () => {
    const w = generateWorld({ seed: 1207, width: 200, height: 500 });
    const sim = new SimWorld(1207, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({
      name: "Phobic",
      x: w.spawn.x,
      y: w.spawn.y + 320, // 320 tiles below spawn — deep rock
      age: 30,
      traitIds: ["phobia_deep"],
    });
    const n = sim.needs.get(id)!;
    n.morale = 50;
    for (let i = 0; i < 60; i++) tick(sim);
    expect(sim.needs.get(id)!.morale).toBeLessThan(50);
  });

  it("Focused/Distractible scale interruptScale and distractChance", () => {
    expect(effectsFor(["focused"]).interruptScale).toBe(0.5);
    expect(effectsFor(["distractible"]).interruptScale).toBe(1.5);
    expect(effectsFor(["distractible"]).distractChance).toBeGreaterThan(0);
    expect(effectsFor([]).distractChance).toBe(0);
  });

  it("Charismatic gives the trade broker a deal-bonus", () => {
    expect(effectsFor(["charismatic"]).tradeBonus).toBeGreaterThan(0);
  });

  it("Antagonistic has a negative auraMorale", () => {
    expect(effectsFor(["antagonistic"]).auraMorale).toBe(-1);
  });

  it("an Antagonistic dwarf drops the morale of nearby dwarves over an hour", () => {
    const w = generateWorld({ seed: 1211, width: 200, height: 500 });
    const sim = new SimWorld(1211, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Grouch", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["antagonistic"] });
    sim.spawnDwarf({ name: "Bystander", x: w.spawn.x + 2, y: w.spawn.y, age: 30 });
    const bystander = sim.dwarf.entities[1];
    sim.needs.get(bystander)!.morale = 80;
    for (let i = 0; i < 60; i++) tick(sim);
    expect(sim.needs.get(bystander)!.morale).toBeLessThan(80);
  });

  it("Night Owl, Empathetic, Phobia: Open Spaces, Ambidextrous each set their flag", () => {
    expect(effectsFor(["night_owl"]).nightOwl).toBe(true);
    expect(effectsFor(["empathetic"]).empathetic).toBe(true);
    expect(effectsFor(["phobia_open"]).phobiaOpen).toBe(true);
    expect(effectsFor(["ambidextrous"]).ambidextrous).toBe(true);
  });

  it("an Empathetic dwarf's morale drifts toward their neighbours' average", () => {
    const w = generateWorld({ seed: 1213, width: 200, height: 500 });
    const sim = new SimWorld(1213, w.grid, w.surfaceY, w.spawn);
    const empath = sim.spawnDwarf({
      name: "Mirror", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["empathetic"],
    });
    sim.spawnDwarf({ name: "Cheery1", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.spawnDwarf({ name: "Cheery2", x: w.spawn.x + 2, y: w.spawn.y, age: 30 });
    sim.needs.get(empath)!.morale = 30;
    // Pin neighbours at 90 morale each tick so the average is high.
    for (let i = 0; i < 60; i++) {
      const ents = sim.dwarf.entities;
      for (const id of ents) {
        if (id === empath) continue;
        const n = sim.needs.get(id);
        if (n) n.morale = 90;
      }
      tick(sim);
    }
    expect(sim.needs.get(empath)!.morale).toBeGreaterThan(30);
  });

  it("a Slow dwarf takes fewer steps than the path length over a fixed window", () => {
    const w = generateWorld({ seed: 1209, width: 200, height: 500 });
    const sim = new SimWorld(1209, w.grid, w.surfaceY, w.spawn);
    // Carve a long corridor.
    for (let xx = w.spawn.x; xx <= w.spawn.x + 30; xx++) {
      sim.grid.setTile(xx, w.spawn.y, 7);
    }
    sim.spawnDwarf({ name: "Slowpoke", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["slow"] });
    const id = sim.dwarf.entities[0];
    // Hand-build a path so movementSystem has something to walk.
    const path = new Int32Array(20);
    for (let i = 0; i < 20; i++) path[i] = (w.spawn.y << 16) | (w.spawn.x + i);
    sim.pathing.set(id, { path, pathIndex: 0, goalX: w.spawn.x + 19, goalY: w.spawn.y });
    sim.job.set(id, { kind: "wander", targetX: w.spawn.x + 19, targetY: w.spawn.y, progress: 0 });
    // Pin needs.
    for (let i = 0; i < 10; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    // After 10 ticks at moveSpeed 0.8, the dwarf should have moved at
    // most 8 steps (probably 8 with the accumulator).
    const pos = sim.position.get(id)!;
    expect(pos.x - w.spawn.x).toBeLessThan(10);
  });
});
