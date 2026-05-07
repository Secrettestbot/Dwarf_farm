import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

function buildSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y });
  return sim;
}

function snapshot(sim: SimWorld): number {
  // Hash all positions and tile flags into a single uint32. Cheap but
  // collision-resistant enough to detect divergence in practice.
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
  // Hash blueprint set so planner-driven divergence is visible.
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
  return h >>> 0;
}

describe("tick determinism", () => {
  it("produces identical state from the same seed across runs", () => {
    const a = buildSim(2024);
    const b = buildSim(2024);
    for (let i = 0; i < 2000; i++) {
      tick(a);
      tick(b);
    }
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it("Colony Planner emits at least one bedroom blueprint without input", () => {
    const sim = buildSim(7);
    expect(sim.planner.blueprints.length).toBe(0);
    // 60 ticks = 1 in-game hour = the planner's evaluation cadence.
    for (let i = 0; i < 120; i++) tick(sim);
    expect(sim.planner.blueprints.length).toBeGreaterThanOrEqual(1);
    const bp = sim.planner.blueprints[0];
    expect(bp.kind).toBe("bedroom");
    expect(bp.cavity.length).toBe(bp.width * bp.height);
  });

  it("the dwarf autonomously mines blueprint cavity tiles", () => {
    const sim = buildSim(7);
    // Run long enough for: planner emit (60 ticks) + dwarf walk + multiple mines.
    for (let i = 0; i < 4000; i++) tick(sim);
    expect(sim.planner.blueprints.length).toBeGreaterThan(0);
    const bp = sim.planner.blueprints[0];
    let dugTiles = 0;
    for (let i = 0; i < bp.cavity.length; i++) {
      const c = bp.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (!sim.grid.isSolid(x, y)) dugTiles++;
    }
    expect(dugTiles).toBeGreaterThan(0);
  });

  it("dwarves never mine outside an active blueprint", () => {
    const sim = buildSim(11);
    const w = sim.grid.width;
    // Capture initial solid set.
    const initialSolid: number[] = [];
    sim.grid.eachChunk((_chunk, _cx, _cy) => {});
    // We sample tiles instead of full grid hash for speed.
    for (let y = 0; y < sim.grid.height; y++) {
      for (let x = 0; x < w; x++) {
        if (sim.grid.isSolid(x, y)) initialSolid.push(y * w + x);
      }
    }
    for (let i = 0; i < 800; i++) tick(sim);
    // Any newly non-solid tile must be inside a blueprint cavity.
    for (const idx of initialSolid) {
      const x = idx % w;
      const y = (idx / w) | 0;
      if (sim.grid.isSolid(x, y)) continue;
      // Was solid; now not. Must be in a blueprint.
      let inBlueprint = false;
      for (const b of sim.planner.blueprints) {
        for (let k = 0; k < b.cavity.length && !inBlueprint; k++) {
          const c = b.cavity[k];
          if ((c & 0xffff) === x && ((c >>> 16) & 0xffff) === y) inBlueprint = true;
        }
        if (inBlueprint) break;
      }
      expect(inBlueprint).toBe(true);
    }
  });
});
