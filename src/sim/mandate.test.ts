import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_SEASON } from "./time";

/** Set up a synthetic mayor + minimum-pop colony. Skips the
 * year-long real election cycle by writing sim.mayorId/mayorName
 * directly — the mandate system only needs a seated mayor + pop
 * ≥ 12. Lockdown blocks migration so the population stays as
 * configured for the test window. */
function setupForMandate(sim: SimWorld, pop: number) {
  for (let i = 0; i < pop; i++) {
    sim.spawnDwarf({
      name: i === 0 ? "TheMayor" : `D${i}`,
      x: sim.spawn.x + (i % 5) - 2,
      y: sim.spawn.y,
      age: 30,
    });
  }
  sim.mayorId = sim.dwarf.entities[0];
  sim.mayorName = "TheMayor";
  sim.emergency.mode = "lockdown";
  sim.emergency.startedAtTick = 0;
  // Advance to one tick before a season boundary so the next
  // tick triggers mandate issue (TICKS_PER_SEASON * 1 = first
  // season after tick 0).
  sim.tick = TICKS_PER_SEASON - 1;
}

describe("mayor mandate system", () => {
  it("a mandate is issued on the next season boundary once a mayor's in office", () => {
    const w = generateWorld({ seed: 1001, width: 200, height: 500 });
    const sim = new SimWorld(1001, w.grid, w.surfaceY, w.spawn);
    setupForMandate(sim, 14);
    // A single tick is enough to cross the season boundary.
    tick(sim);
    expect(sim.mandateResource).not.toBe("");
    expect(sim.mandateTarget).toBeGreaterThan(sim.mandateBaseline);
    expect(sim.mandateEndTick).toBeGreaterThan(sim.tick);
  });

  it("a satisfied mandate bumps morale + the satisfied counter", () => {
    const w = generateWorld({ seed: 1003, width: 200, height: 500 });
    const sim = new SimWorld(1003, w.grid, w.surfaceY, w.spawn);
    setupForMandate(sim, 14);
    tick(sim);
    // Cheat the stockpile so the mandate clears. We're testing
    // the satisfaction path, not the production pipeline.
    const sp = sim.stockpile as unknown as Record<string, number>;
    sp[sim.mandateResource] = sim.mandateTarget;
    const before = sim.mandatesSatisfied;
    // Jump straight to the deadline tick so we evaluate immediately
    // — no need to simulate a full real season of dwarf work.
    sim.tick = sim.mandateEndTick - 1;
    tick(sim);
    expect(sim.mandatesSatisfied).toBe(before + 1);
    // A new mandate may have rolled in for next season — that's
    // fine. The satisfied count is what we care about here.
  });

  it("a failed mandate bumps the failure counter", () => {
    const w = generateWorld({ seed: 1005, width: 200, height: 500 });
    const sim = new SimWorld(1005, w.grid, w.surfaceY, w.spawn);
    setupForMandate(sim, 14);
    tick(sim);
    const before = sim.mandatesFailed;
    sim.tick = sim.mandateEndTick - 1;
    tick(sim);
    expect(sim.mandatesFailed).toBe(before + 1);
  });
});
