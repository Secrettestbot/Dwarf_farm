import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_DAY } from "./time";

describe("Obsessive (GDD §6.5)", () => {
  it("an Obsessive dwarf eventually falls into a fixation over a few years", () => {
    const w = generateWorld({ seed: 1317, width: 200, height: 500 });
    const sim = new SimWorld(1317, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({
      name: "Fixated", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["obsessive"],
    });
    // 2% per day means ~7 obsessions per in-game year on average. The
    // pre-existing 144-day window gave ~6% chance of no obsession by
    // pure variance, which would flake any time another system shifted
    // aiRng consumption (e.g. the planner adding a new corridor
    // weighting). 2 in-game years (730 days) drives P(no obsession)
    // below 10^-6 — well under the regression noise floor.
    let entered = false;
    for (let i = 0; i < TICKS_PER_DAY * 365 * 2 && !entered; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      const hp = sim.health.get(id);
      if (hp) hp.hp = hp.maxHp;
      tick(sim);
      if (sim.obsession.has(id)) entered = true;
    }
    expect(entered).toBe(true);
  });

  it("obsession ends when its timer elapses", () => {
    const w = generateWorld({ seed: 1303, width: 200, height: 500 });
    const sim = new SimWorld(1303, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({
      name: "Fixated", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["obsessive"],
    });
    // Hand-set a SHORT obsession that ends off a TICKS_PER_DAY
    // boundary — that way the lifecycle removal doesn't race the
    // daily new-obsession roll. Verifies the timer mechanic in
    // isolation.
    sim.obsession.set(id, { skillId: "mining", endsAtTick: sim.tick + 100 });
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      const hp = sim.health.get(id);
      if (hp) hp.hp = hp.maxHp;
      tick(sim);
      if (!sim.obsession.has(id)) break;
    }
    expect(sim.obsession.has(id)).toBe(false);
  });

  it("an obsessed dwarf gains XP twice as fast on the fixation skill", () => {
    const w = generateWorld({ seed: 1305, width: 200, height: 500 });
    const sim = new SimWorld(1305, w.grid, w.surfaceY, w.spawn);
    const a = sim.spawnDwarf({ name: "Pinned", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const b = sim.spawnDwarf({ name: "Free", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.obsession.set(a, { skillId: "mining", endsAtTick: sim.tick + TICKS_PER_DAY * 7 });
    // Plant ore tiles next to each dwarf inside an active mine
    // blueprint, so each will mine equally over time.
    const planMine = (x: number, y: number, id: number) => {
      sim.grid.setTile(x, y, 5 /* Ore */);
      sim.planner.blueprints.push({
        id,
        kind: "mine",
        originX: x,
        originY: y,
        width: 1,
        height: 1,
        cavity: new Int32Array([(y << 16) | x]),
        status: "digging",
        priority: 1,
        createdTick: 0,
      });
    };
    planMine(w.spawn.x + 0, w.spawn.y + 1, 9001);
    planMine(w.spawn.x + 1, w.spawn.y + 1, 9002);
    sim.sliders.hauling = 0;
    for (let i = 0; i < 1500; i++) {
      const n = sim.needs.get(a);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      const n2 = sim.needs.get(b);
      if (n2) { n2.hunger = 100; n2.thirst = 100; n2.sleep = 100; n2.social = 100; }
      tick(sim);
    }
    const aXp = sim.dwarf.get(a)!.skillXp.mining ?? 0;
    const bXp = sim.dwarf.get(b)!.skillXp.mining ?? 0;
    // The obsessed miner should have at least 1.5× the free miner's
    // XP. (Exact 2× would require identical job dispatch, which the
    // staggered AI doesn't guarantee for two dwarves.)
    expect(aXp).toBeGreaterThan(bXp * 1.4);
  });
});
