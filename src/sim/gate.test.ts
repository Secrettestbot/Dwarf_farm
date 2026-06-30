import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

// The gate is the controllable breach in the rampart: the colony
// raises it during a siege (blocking the gap), and siege-breakers
// batter it down — so it buys time rather than granting immunity.
// These drive the gate state directly rather than waiting a full
// year for an organic siege.

function buildGate(sim: SimWorld, x: number, y: number, integrity = 600): void {
  sim.grid.setTile(x, y, TileType.Gate);
  sim.gate = { x, y, closed: false, integrity };
}

describe("entrance gate", () => {
  it("the colony raises the gate during a siege and lowers it afterward", () => {
    const w = generateWorld({ seed: 921, width: 200, height: 500 });
    const sim = new SimWorld(921, w.grid, w.surfaceY, w.spawn);
    buildGate(sim, w.spawn.x, w.spawn.y);
    expect(sim.gate!.closed).toBe(false);
    // A siege-spawned hostile far from the gate sustains siegeActive
    // (siegeSystem clears the siege if no fromSiege attacker is left).
    sim.spawnHostile({ kind: "goblin_scout", x: w.spawn.x + 20, y: w.spawn.y, fromSiege: true });
    sim.siegeActive = true;
    tick(sim);
    expect(sim.gate!.closed).toBe(true);
    // Siege over: the gate lowers again.
    sim.siegeActive = false;
    tick(sim);
    expect(sim.gate!.closed).toBe(false);
  });

  it("a closed gate blocks a hostile from crossing the gap", () => {
    const w = generateWorld({ seed: 923, width: 200, height: 500 });
    const sim = new SimWorld(923, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    const gx = sx + 1;
    buildGate(sim, gx, sy);
    sim.gate!.closed = true;
    sim.siegeActive = true; // keeps it closed through the run
    const dwarfId = sim.spawnDwarf({ name: "Bait", x: sx, y: sy, age: 30 });
    const hostileId = sim.spawnHostile({ kind: "goblin_scout", x: sx + 2, y: sy, fromSiege: true });
    let everOnGate = false;
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(dwarfId);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      const dp = sim.position.get(dwarfId);
      if (dp) { dp.x = sx; dp.y = sy; }
      // A lone scout barely dents a 600-integrity gate, so it stays
      // closed for the whole run.
      tick(sim);
      const hp = sim.position.get(hostileId);
      if (hp && hp.x === gx && hp.y === sy) everOnGate = true;
      if (!sim.ecs.isAlive(hostileId)) break;
    }
    expect(everOnGate).toBe(false);
    expect(sim.gate!.closed).toBe(true); // never breached by one scout
  });

  it("a siege-breaker batters the gate down and breaches it", () => {
    const w = generateWorld({ seed: 925, width: 200, height: 500 });
    const sim = new SimWorld(925, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    const gx = sx + 1;
    // A modest integrity so the troll breaches within the test window.
    buildGate(sim, gx, sy, 200);
    sim.siegeActive = true;
    // A cave troll (battering-ram multiplier) parked against the gate.
    const trollId = sim.spawnHostile({ kind: "cave_troll", x: gx + 1, y: sy, fromSiege: true });
    let breached = false;
    for (let i = 0; i < 2000; i++) {
      // Pin the troll adjacent so it keeps hammering rather than
      // wandering off.
      const tp = sim.position.get(trollId);
      if (tp) { tp.x = gx + 1; tp.y = sy; }
      tick(sim);
      if (sim.gate!.integrity <= 0) { breached = true; break; }
    }
    expect(breached).toBe(true);
    expect(sim.gate!.closed).toBe(false); // breach forces it open
    const breachLine = sim.events.events.find((e) => e.text.includes("breached"));
    expect(breachLine).toBeDefined();
  });

  it("a lone scout cannot breach a full-integrity gate in the time a troll can", () => {
    const w = generateWorld({ seed: 927, width: 200, height: 500 });
    const sim = new SimWorld(927, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    const gx = sx + 1;
    buildGate(sim, gx, sy, 600);
    sim.siegeActive = true;
    const scoutId = sim.spawnHostile({ kind: "goblin_scout", x: gx + 1, y: sy, fromSiege: true });
    for (let i = 0; i < 2000; i++) {
      const sp = sim.position.get(scoutId);
      if (sp) { sp.x = gx + 1; sp.y = sy; }
      tick(sim);
    }
    // Scout chips it (8 dmg / 60 ticks ≈ ~260 over 2000 ticks) but
    // nowhere near the 600 needed — the gate holds against a rabble.
    expect(sim.gate!.integrity).toBeGreaterThan(0);
    expect(sim.gate!.closed).toBe(true);
  });

  it("the gate state round-trips through save/restore", async () => {
    const { snapshot, restore } = await import("../save/snapshot");
    const w = generateWorld({ seed: 929, width: 200, height: 500 });
    const sim = new SimWorld(929, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Keeper", x: w.spawn.x, y: w.spawn.y, age: 30 });
    buildGate(sim, w.spawn.x, w.spawn.y, 340);
    sim.gate!.closed = true;
    const save = snapshot({
      sim, slotId: "slot-1", fortressName: "fortress", mode: "legacy",
      cameraX: 0, cameraY: 0, zoomIndex: 1,
    });
    const restored = restore(save);
    expect(restored.gate).toEqual({ x: w.spawn.x, y: w.spawn.y, closed: true, integrity: 340 });
  });
});
