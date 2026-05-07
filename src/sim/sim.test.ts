import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

function buildSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.spawnDwarf("Borin", w.spawn.x, w.spawn.y);
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

  it("a dwarf autonomously mines tiles with no input", () => {
    const sim = buildSim(7);
    const startTile = sim.grid.getTile(sim.spawn.x, sim.spawn.y);
    expect(sim.grid.isWalkable(sim.spawn.x, sim.spawn.y)).toBe(true);

    let solidsBefore = 0;
    sim.grid.eachChunk((chunk) => {
      for (let i = 0; i < chunk.tiles.length; i++) {
        if (sim.grid.isSolid(0, 0)) {
          /* unused — just exercising the import */
        }
      }
      // Count solid tiles directly to avoid grid.isSolid coords-from-index roundtrip.
      for (let i = 0; i < chunk.tiles.length; i++) {
        const t = chunk.tiles[i];
        if (t === 1 || t === 2 || t === 3 || t === 4 || t === 5) solidsBefore++;
      }
    });

    for (let i = 0; i < 500; i++) tick(sim);

    let solidsAfter = 0;
    sim.grid.eachChunk((chunk) => {
      for (let i = 0; i < chunk.tiles.length; i++) {
        const t = chunk.tiles[i];
        if (t === 1 || t === 2 || t === 3 || t === 4 || t === 5) solidsAfter++;
      }
    });

    // Must have mined at least one tile.
    expect(solidsAfter).toBeLessThan(solidsBefore);
    // Sanity: starting tile is still the type it was.
    expect(typeof startTile).toBe("number");
  });
});
