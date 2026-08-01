import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

// Long-run invariant soak. Rather than asserting one scripted outcome,
// this drives whole colonies for tens of thousands of ticks and checks
// the invariants every sim change must preserve. It exists to catch
// the bug *classes* — leaked claims, negative counters, NaN needs,
// planner drift — that scenario tests only catch one instance of.

const CHECK_EVERY = 1000;

function checkInvariants(sim: SimWorld, seed: number): void {
  const at = `seed ${seed}, tick ${sim.tick}`;

  // 1. No stockpile counter is negative or NaN.
  for (const [key, value] of Object.entries(sim.stockpile as unknown as Record<string, number>)) {
    expect(value, `stockpile.${key} at ${at}`).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(value), `stockpile.${key} finite at ${at}`).toBe(true);
  }

  // 2. No floor item is claimed by a dead entity, and no item sits
  //    out of bounds.
  for (const ie of sim.item.entities) {
    const it = sim.item.get(ie)!;
    if (it.claimedBy !== -1) {
      expect(sim.ecs.isAlive(it.claimedBy), `item claim liveness at ${at}`).toBe(true);
    }
    const p = sim.position.get(ie);
    expect(p, `item position at ${at}`).toBeDefined();
    expect(sim.grid.inBounds(p!.x, p!.y), `item in bounds at ${at}`).toBe(true);
  }

  // 3. Every dwarf's needs are finite and within 0..100; positions in
  //    bounds; partner references mutual and alive.
  sim.forEachDwarf((id, pos, dw) => {
    const n = sim.needs.get(id);
    if (n) {
      for (const key of ["sleep", "social", "hunger", "thirst", "morale"] as const) {
        const v = n[key];
        expect(Number.isFinite(v), `needs.${key} finite at ${at}`).toBe(true);
        expect(v, `needs.${key} range at ${at}`).toBeGreaterThanOrEqual(0);
        expect(v, `needs.${key} range at ${at}`).toBeLessThanOrEqual(100);
      }
    }
    expect(sim.grid.inBounds(pos.x, pos.y), `dwarf in bounds at ${at}`).toBe(true);
    if (dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
      const partner = sim.dwarf.get(dw.partnerId);
      expect(partner?.partnerId, `partner mutuality at ${at}`).toBe(id);
    }
  });

  // 4. Mine claims only exist for tiles that are still solid — a claim
  //    on open floor means a release was missed.
  for (const packed of sim.mineClaims) {
    const x = packed & 0xffff;
    const y = (packed >>> 16) & 0xffff;
    expect(sim.grid.isSolid(x, y), `mine claim on solid rock at ${at} (${x},${y})`).toBe(true);
  }

  // 5. Planner counters agree with blueprint statuses.
  let complete = 0;
  for (const b of sim.planner.blueprints) {
    if (b.status === "complete") complete++;
  }
  expect(sim.planner.completed, `planner.completed consistency at ${at}`).toBe(complete);

  // 6. Every job/pathing/carrying component belongs to a live entity.
  for (const stores of [sim.job, sim.pathing, sim.carrying] as const) {
    for (const e of stores.entities) {
      expect(sim.ecs.isAlive(e), `component owner liveness at ${at}`).toBe(true);
    }
  }
}

describe("soak: long-run sim invariants", () => {
  for (const seed of [8801, 8802]) {
    it(`seed ${seed} holds all invariants over 30k ticks`, () => {
      const w = generateWorld({ seed, width: 200, height: 500 });
      const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
      for (let i = 0; i < 7; i++) {
        sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 22 + i });
      }
      for (let i = 0; i < 30_000; i++) {
        tick(sim);
        if (sim.tick % CHECK_EVERY === 0) checkInvariants(sim, seed);
      }
      checkInvariants(sim, seed);
    });
  }
});
