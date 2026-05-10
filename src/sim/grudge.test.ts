import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { grudgeCount } from "./sim";
import { TICKS_PER_DAY } from "./time";

describe("grudges", () => {
  it("two adjacent Antagonistic dwarves accrue a grudge over time", () => {
    const w = generateWorld({ seed: 511, width: 200, height: 500 });
    const sim = new SimWorld(511, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    const a = sim.spawnDwarf({ name: "Argo", x: sx, y: sy, age: 30, traitIds: ["antagonistic"] });
    const b = sim.spawnDwarf({ name: "Bron", x: sx + 1, y: sy, age: 30, traitIds: ["antagonistic"] });
    // Pin them adjacent and need-satisfied so chooseTask doesn't pull
    // them apart. Run a couple of in-game years; grudges are daily.
    for (let i = 0; i < TICKS_PER_DAY * 60; i++) {
      const apos = sim.position.get(a)!;
      const bpos = sim.position.get(b)!;
      apos.x = sx; apos.y = sy;
      bpos.x = sx + 1; bpos.y = sy;
      const an = sim.needs.get(a); if (an) { an.hunger = 100; an.thirst = 100; an.sleep = 100; an.social = 100; }
      const bn = sim.needs.get(b); if (bn) { bn.hunger = 100; bn.thirst = 100; bn.sleep = 100; bn.social = 100; }
      tick(sim);
    }
    expect(grudgeCount(sim, a, b)).toBeGreaterThan(0);
  });

  it("a long-running grudge eventually escalates to a brawl event", () => {
    const w = generateWorld({ seed: 521, width: 200, height: 500 });
    const sim = new SimWorld(521, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    const a = sim.spawnDwarf({ name: "Cael", x: sx, y: sy, age: 30, traitIds: ["antagonistic"] });
    const b = sim.spawnDwarf({ name: "Drun", x: sx + 1, y: sy, age: 30, traitIds: ["antagonistic"] });
    // Seed a deep grudge directly so we don't have to wait years for
    // the daily roll to climb. Simulating a brawl roll then becomes
    // a matter of running enough days.
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    sim.grudges.set(key, { count: 12, lastIncidentTick: 0 });
    let brawlSeen = false;
    for (let i = 0; i < TICKS_PER_DAY * 60 && !brawlSeen; i++) {
      const apos = sim.position.get(a)!;
      const bpos = sim.position.get(b)!;
      apos.x = sx; apos.y = sy;
      bpos.x = sx + 1; bpos.y = sy;
      const an = sim.needs.get(a); if (an) { an.hunger = 100; an.thirst = 100; an.sleep = 100; an.social = 100; }
      const bn = sim.needs.get(b); if (bn) { bn.hunger = 100; bn.thirst = 100; bn.sleep = 100; bn.social = 100; }
      tick(sim);
      brawlSeen = sim.events.events.some((e) => e.text.includes("grudge between them spills into blood"));
    }
    expect(brawlSeen).toBe(true);
  });
});
