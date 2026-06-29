import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick, grudgeCount } from "./sim";
import { TileType } from "./world/tiles";
import { TICKS_PER_DAY } from "./time";

// Reconciliation: a standing grudge between two content, non-
// antagonistic dwarves who share space should fade over time and
// eventually be buried with a chronicle line — the counterweight to
// the argument/brawl escalation. The escalation path keeps its own
// coverage in grudge.test.ts.

function pinAdjacentContentByTavern(sim: SimWorld, a: number, b: number, sx: number, sy: number): void {
  const apos = sim.position.get(a)!;
  const bpos = sim.position.get(b)!;
  apos.x = sx; apos.y = sy;
  bpos.x = sx + 1; bpos.y = sy;
  // No jobs/paths so movement can't drag them apart before the
  // (late-tick) argument/reconcile pass reads their positions.
  sim.job.remove(a); sim.job.remove(b);
  sim.pathing.remove(a); sim.pathing.remove(b);
  // Content + fed: high morale unlocks the good-spirits bonus on both
  // the reduced-argument and the reconciliation rolls.
  for (const id of [a, b]) {
    const n = sim.needs.get(id);
    if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; n.morale = 100; }
    // Keep them at full HP — the test pins them perpetually adjacent,
    // which is not how dwarves normally live; without this an
    // unlucky run of brawls could beat one to death and (via
    // killDwarf clearing grudges) confound the assertions.
    const h = sim.health.get(id);
    if (h) h.hp = h.maxHp;
  }
}

describe("grudge reconciliation", () => {
  it("a small grudge between content, tavern-sharing dwarves is buried over time", () => {
    const w = generateWorld({ seed: 811, width: 200, height: 500 });
    const sim = new SimWorld(811, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Tavern counter under the pair → "sharing a drink" reconcile bonus.
    sim.grid.setTile(sx, sy, TileType.TavernCounter);
    const a = sim.spawnDwarf({ name: "Amal", x: sx, y: sy, age: 30 });
    const b = sim.spawnDwarf({ name: "Berin", x: sx + 1, y: sy, age: 30 });
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    sim.grudges.set(key, { count: 2, lastIncidentTick: 0, peak: 2 });

    // Detect reconciliation by the chronicle line, not grudgeCount===0:
    // passive decay alone can zero the count without a reconciliation
    // ever happening, so the line is the real signal.
    let reconciledLine = false;
    for (let i = 0; i < TICKS_PER_DAY * 120 && !reconciledLine; i++) {
      pinAdjacentContentByTavern(sim, a, b, sx, sy);
      tick(sim);
      reconciledLine = sim.events.events.some(
        (e) => e.text.includes("patch up their quarrel") || e.text.includes("let a small grievance go"),
      );
    }
    expect(reconciledLine).toBe(true);
    // The grudge ledger should be clear once it's been buried.
    expect(grudgeCount(sim, a, b)).toBe(0);
  });

  it("burying a deep feud fires the weighty chronicle line and clears the ledger", () => {
    const w = generateWorld({ seed: 821, width: 200, height: 500 });
    const sim = new SimWorld(821, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.grid.setTile(sx, sy, TileType.TavernCounter);
    const a = sim.spawnDwarf({ name: "Cila", x: sx, y: sy, age: 30 });
    const b = sim.spawnDwarf({ name: "Doran", x: sx + 1, y: sy, age: 30 });
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    // A feud that already cooled below the brawl threshold (low live
    // count) but once ran deep (peak 7). An active count >= 4 would
    // keep brawling instead of reconciling, so the realistic path to a
    // weighty burial is an old grudge that's gone quiet. peak drives
    // the chronicle pool, so the deep-feud line should fire.
    sim.grudges.set(key, { count: 2, lastIncidentTick: 0, peak: 7 });

    let deepLineFired = false;
    for (let i = 0; i < TICKS_PER_DAY * 200 && !deepLineFired; i++) {
      pinAdjacentContentByTavern(sim, a, b, sx, sy);
      tick(sim);
      deepLineFired = sim.events.events.some(
        (e) =>
          e.text.includes("enemies for as long") ||
          e.text.includes("feud between") ||
          e.text.includes("years-deep grudge"),
      );
    }
    expect(deepLineFired).toBe(true);
    // Ledger cleared once buried.
    expect(sim.grudges.has(key)).toBe(false);
  });

  it("an Antagonistic pair does NOT easily reconcile — the feud persists", () => {
    const w = generateWorld({ seed: 831, width: 200, height: 500 });
    const sim = new SimWorld(831, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.grid.setTile(sx, sy, TileType.TavernCounter);
    const a = sim.spawnDwarf({ name: "Esk", x: sx, y: sy, age: 30, traitIds: ["antagonistic"] });
    const b = sim.spawnDwarf({ name: "Fenn", x: sx + 1, y: sy, age: 30, traitIds: ["antagonistic"] });
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    sim.grudges.set(key, { count: 5, lastIncidentTick: 0, peak: 5 });

    for (let i = 0; i < TICKS_PER_DAY * 60; i++) {
      pinAdjacentContentByTavern(sim, a, b, sx, sy);
      tick(sim);
    }
    // Antagonistic dwarves get a 0.3x reconcile penalty and keep
    // arguing, so the grudge should still be on the books.
    expect(sim.grudges.has(key)).toBe(true);
  });
});
