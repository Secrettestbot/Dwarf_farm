import { describe, it, expect } from "vitest";
import { generateWorld } from "./worldgen";
import { CHUNK_SIZE } from "./grid";

function hashBytes(b: Uint8Array): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

describe("worldgen", () => {
  it("is deterministic for the same seed/dimensions", () => {
    const a = generateWorld({ seed: 12345, width: 200, height: 500 });
    const b = generateWorld({ seed: 12345, width: 200, height: 500 });
    expect(a.spawn).toEqual(b.spawn);
    a.grid.eachChunk((chunkA, cx, cy) => {
      const chunkB = b.grid.rawChunk(cx, cy);
      expect(hashBytes(chunkA.tiles)).toBe(hashBytes(chunkB.tiles));
    });
  });

  it("differs for different seeds", () => {
    const a = generateWorld({ seed: 1, width: 200, height: 500 });
    const b = generateWorld({ seed: 2, width: 200, height: 500 });
    let differingChunks = 0;
    a.grid.eachChunk((chunkA, cx, cy) => {
      const chunkB = b.grid.rawChunk(cx, cy);
      if (hashBytes(chunkA.tiles) !== hashBytes(chunkB.tiles)) differingChunks++;
    });
    expect(differingChunks).toBeGreaterThan(0);
  });

  it("places spawn on a walkable tile", () => {
    const w = generateWorld({ seed: 99, width: 200, height: 500 });
    expect(w.grid.isWalkable(w.spawn.x, w.spawn.y)).toBe(true);
  });

  it("uses chunked storage of the right size", () => {
    const w = generateWorld({ seed: 1, width: 200, height: 500 });
    expect(w.grid.chunksX).toBe(200 / CHUNK_SIZE);
    expect(w.grid.chunksY).toBe(500 / CHUNK_SIZE);
  });
});
