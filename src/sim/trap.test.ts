import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick, trapPrimed } from "./sim";
import { TileType } from "./world/tiles";

// Weapon traps: the militia-independent damage source in the entrance
// kill zone. They spring on hostiles, never on dwarves, then recharge.
// Most tests drive the trap directly (place a Trap tile + register it)
// rather than waiting for an organic siege to build one.

function placeTrap(sim: SimWorld, x: number, y: number): void {
  sim.grid.setTile(x, y, TileType.Trap);
  // Armed immediately: last sprung far enough in the past to be primed.
  sim.traps.push({ x, y, lastSprungTick: -10_000 });
}

describe("entrance traps", () => {
  it("trapPrimed reports armed, then recharging after a spring", () => {
    expect(trapPrimed({ lastSprungTick: -10_000 }, 0)).toBe(true);
    // Just fired at tick 1000 → not primed shortly after...
    expect(trapPrimed({ lastSprungTick: 1000 }, 1010)).toBe(false);
    // ...but primed again well past the recharge window.
    expect(trapPrimed({ lastSprungTick: 1000 }, 1000 + 180)).toBe(true);
  });

  it("a primed trap springs on a hostile standing on it and recharges", () => {
    const w = generateWorld({ seed: 941, width: 200, height: 500 });
    const sim = new SimWorld(941, w.grid, w.surfaceY, w.spawn);
    const tx = w.spawn.x;
    const ty = w.spawn.y;
    placeTrap(sim, tx, ty);
    const hostileId = sim.spawnHostile({ kind: "goblin_scout", x: tx, y: ty });
    const hpBefore = sim.health.get(hostileId)!.hp;
    // Pin the hostile on the trap tile and tick once.
    const hp = sim.position.get(hostileId)!;
    hp.x = tx; hp.y = ty;
    tick(sim);
    // Either it took damage or it died outright (28 dmg vs 50 hp →
    // wounded, survives the first hit).
    expect(sim.ecs.isAlive(hostileId)).toBe(true);
    expect(sim.health.get(hostileId)!.hp).toBeLessThan(hpBefore);
    // The trap is now recharging.
    expect(sim.traps[0].lastSprungTick).toBe(sim.tick);
    expect(trapPrimed(sim.traps[0], sim.tick)).toBe(false);
    const woundedHp = sim.health.get(hostileId)!.hp;
    // Next tick, still on the trap, but it's spent — no further damage.
    hp.x = tx; hp.y = ty;
    tick(sim);
    expect(sim.health.get(hostileId)!.hp).toBe(woundedHp);
  });

  it("a trap never harms a dwarf standing on it", () => {
    const w = generateWorld({ seed: 943, width: 200, height: 500 });
    const sim = new SimWorld(943, w.grid, w.surfaceY, w.spawn);
    const tx = w.spawn.x;
    const ty = w.spawn.y;
    placeTrap(sim, tx, ty);
    const dwarfId = sim.spawnDwarf({ name: "Walker", x: tx, y: ty, age: 30 });
    const hpBefore = sim.health.get(dwarfId)!.hp;
    for (let i = 0; i < 50; i++) {
      const n = sim.needs.get(dwarfId);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      const p = sim.position.get(dwarfId)!;
      p.x = tx; p.y = ty;
      tick(sim);
    }
    expect(sim.health.get(dwarfId)!.hp).toBe(hpBefore);
    // The trap stayed armed — it never fired on a friendly.
    expect(trapPrimed(sim.traps[0], sim.tick)).toBe(true);
  });

  it("repeated waves: the trap re-arms and bites again after its recharge", () => {
    const w = generateWorld({ seed: 945, width: 200, height: 500 });
    const sim = new SimWorld(945, w.grid, w.surfaceY, w.spawn);
    const tx = w.spawn.x;
    const ty = w.spawn.y;
    placeTrap(sim, tx, ty);
    // First victim.
    const a = sim.spawnHostile({ kind: "goblin_scout", x: tx, y: ty });
    sim.position.get(a)!.x = tx; sim.position.get(a)!.y = ty;
    tick(sim);
    const firstSpring = sim.traps[0].lastSprungTick;
    // Clear the first victim off the trap (a hostile that lingers would
    // keep re-triggering it on every recharge — correct, but here we
    // want to test re-arming on an empty tile).
    sim.position.get(a)!.x = tx + 10;
    // Run past the recharge window with no hostile on the trap.
    for (let i = 0; i < 200; i++) tick(sim);
    expect(trapPrimed(sim.traps[0], sim.tick)).toBe(true);
    // Second victim arrives onto the re-armed trap.
    const b = sim.spawnHostile({ kind: "goblin_scout", x: tx, y: ty });
    const bHp = sim.health.get(b)!.hp;
    sim.position.get(b)!.x = tx; sim.position.get(b)!.y = ty;
    tick(sim);
    expect(sim.health.get(b)!.hp).toBeLessThan(bHp);
    expect(sim.traps[0].lastSprungTick).toBeGreaterThan(firstSpring);
  });

  it("the architect plans traps behind the gate when the entrance has floor", () => {
    const w = generateWorld({ seed: 947, width: 200, height: 500 });
    const sim = new SimWorld(947, w.grid, w.surfaceY, w.spawn);
    // Carve a short entrance shaft below the gate column so the trap
    // planner has corridor floor to sit traps on.
    for (let dy = 1; dy <= 4; dy++) {
      sim.grid.setTile(w.spawn.x, w.surfaceY[w.spawn.x] + dy, TileType.CorridorFloor);
    }
    for (let i = 0; i < 12; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    for (let i = 0; i < 60 * 24 * 3 && sim.trapPlanTiles.length === 0; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    expect(sim.trapPlanTiles.length).toBeGreaterThan(0);
    // Trap sites are part of the build plan and sit below the entrance.
    for (const p of sim.trapPlanTiles) {
      expect(sim.fortificationPlan.includes(p)).toBe(true);
      const y = (p >>> 16) & 0xffff;
      expect(y).toBeGreaterThan(sim.surfaceY[w.spawn.x]);
    }
  });

  it("traps round-trip through save/restore", async () => {
    const { snapshot, restore } = await import("../save/snapshot");
    const w = generateWorld({ seed: 949, width: 200, height: 500 });
    const sim = new SimWorld(949, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Keeper", x: w.spawn.x, y: w.spawn.y, age: 30 });
    placeTrap(sim, 10, 20);
    sim.traps[0].lastSprungTick = 4242;
    sim.trapPlanTiles = [(21 << 16) | 10];
    const save = snapshot({
      sim, slotId: "slot-1", fortressName: "fortress", mode: "legacy",
      cameraX: 0, cameraY: 0, zoomIndex: 1,
    });
    const restored = restore(save);
    expect(restored.traps).toEqual([{ x: 10, y: 20, lastSprungTick: 4242 }]);
    expect(restored.trapPlanTiles).toEqual([(21 << 16) | 10]);
  });
});
