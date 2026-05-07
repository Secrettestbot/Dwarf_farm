import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { SimWorld } from "../sim/world/simWorld";
import { tick } from "../sim/sim";
import { snapshot, restore } from "./snapshot";

function buildSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y });
  return sim;
}

function hashSim(sim: SimWorld): number {
  let h = 2166136261 >>> 0;
  sim.forEachDwarf((_id, pos) => {
    h ^= pos.x;
    h = Math.imul(h, 16777619);
    h ^= pos.y;
    h = Math.imul(h, 16777619);
  });
  sim.grid.eachChunk((chunk) => {
    for (let i = 0; i < chunk.tiles.length; i++) {
      h ^= chunk.tiles[i];
      h = Math.imul(h, 16777619);
    }
  });
  for (const b of sim.planner.blueprints) {
    h ^= b.id;
    h = Math.imul(h, 16777619);
    h ^= b.originX;
    h = Math.imul(h, 16777619);
    h ^= b.originY;
    h = Math.imul(h, 16777619);
    h ^= b.status === "complete" ? 1 : 0;
    h = Math.imul(h, 16777619);
  }
  h ^= sim.tick;
  h = Math.imul(h, 16777619);
  return h >>> 0;
}

describe("snapshot/restore", () => {
  it("round-trips an unmodified sim", () => {
    const a = buildSim(99);
    const save = snapshot({ sim: a, slotId: "slot0", fortressName: "Test Hold", mode: "legacy", cameraX: 0, cameraY: 0, zoomIndex: 1 });
    const b = restore(save);
    expect(hashSim(b)).toBe(hashSim(a));
  });

  it("survives a serialize → run → assert match against a continued source", () => {
    // Run sim A 500 ticks. Snapshot. Restore into B. Run both another 500.
    // Final state must match.
    const a = buildSim(123);
    for (let i = 0; i < 500; i++) tick(a);
    const save = snapshot({ sim: a, slotId: "slot0", fortressName: "Test Hold", mode: "legacy", cameraX: 0, cameraY: 0, zoomIndex: 1 });
    const b = restore(save);
    expect(hashSim(b)).toBe(hashSim(a));
    for (let i = 0; i < 500; i++) {
      tick(a);
      tick(b);
    }
    expect(hashSim(b)).toBe(hashSim(a));
  });

  it("preserves blueprints across save/restore", () => {
    const a = buildSim(42);
    for (let i = 0; i < 200; i++) tick(a);
    expect(a.planner.blueprints.length).toBeGreaterThan(0);
    const save = snapshot({ sim: a, slotId: "slot0", fortressName: "Test Hold", mode: "legacy", cameraX: 0, cameraY: 0, zoomIndex: 1 });
    const b = restore(save);
    expect(b.planner.blueprints.length).toBe(a.planner.blueprints.length);
    expect(b.planner.blueprints[0].originX).toBe(a.planner.blueprints[0].originX);
    expect(b.planner.blueprints[0].originY).toBe(a.planner.blueprints[0].originY);
    expect(b.planner.nextId).toBe(a.planner.nextId);
    expect(b.planner.completed).toBe(a.planner.completed);
  });
});
