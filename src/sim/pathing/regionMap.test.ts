import { describe, it, expect } from "vitest";
import { TileGrid } from "../world/grid";
import { TileType } from "../world/tiles";
import { RegionMap } from "./regionMap";
import { Rng } from "../rng";

function carve(grid: TileGrid, x: number, y: number, w: number, h: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) grid.setTile(xx, yy, TileType.CorridorFloor);
  }
}

describe("RegionMap", () => {
  it("flags two disconnected pockets as different regions", () => {
    const grid = new TileGrid(100, 100);
    // Fill with stone first.
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) grid.setTile(x, y, TileType.Stone);
    }
    // Two carved cavities with no walkable connection.
    carve(grid, 4, 4, 6, 6);
    carve(grid, 30, 30, 6, 6);
    const map = new RegionMap(100, 100);
    const a = map.regionAt(grid, 5, 5);
    const b = map.regionAt(grid, 32, 32);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    expect(map.connected(grid, 5, 5, 32, 32)).toBe(false);
  });

  it("merges regions when a corridor opens between them", () => {
    const grid = new TileGrid(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) grid.setTile(x, y, TileType.Stone);
    }
    carve(grid, 4, 4, 6, 6);
    carve(grid, 30, 4, 6, 6);
    const map = new RegionMap(100, 100);
    expect(map.connected(grid, 5, 5, 32, 5)).toBe(false);
    // Open the corridor between them.
    carve(grid, 10, 5, 20, 1);
    map.invalidate();
    expect(map.connected(grid, 5, 5, 32, 5)).toBe(true);
  });

  it("splits a region when a tile is blocked (full-rebuild fallback)", () => {
    const grid = new TileGrid(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) grid.setTile(x, y, TileType.Stone);
    }
    carve(grid, 4, 4, 30, 1);
    const map = new RegionMap(100, 100);
    expect(map.connected(grid, 4, 4, 33, 4)).toBe(true);
    grid.setTile(20, 4, TileType.Stone);
    map.invalidate();
    expect(map.connected(grid, 4, 4, 33, 4)).toBe(false);
  });

  it("incremental updates agree with a fresh full rebuild", () => {
    // Random caves, then random mining (opens) with occasional
    // blocks, interleaved with queries. After every step the long-
    // lived (incrementally updated) map must answer connected()
    // exactly like a brand-new map built from scratch.
    const rng = new Rng(0x1234, 0x5678);
    const N = 100;
    const grid = new TileGrid(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) grid.setTile(x, y, rng.nextFloat() < 0.45 ? TileType.CorridorFloor : TileType.Stone);
    }
    const live = new RegionMap(N, N);
    const probe = (): void => {
      const fresh = new RegionMap(N, N);
      for (let q = 0; q < 200; q++) {
        const ax = rng.nextRange(0, N), ay = rng.nextRange(0, N);
        const bx = rng.nextRange(0, N), by = rng.nextRange(0, N);
        expect(live.connected(grid, ax, ay, bx, by)).toBe(fresh.connected(grid, ax, ay, bx, by));
      }
    };
    probe();
    for (let step = 0; step < 60; step++) {
      const blocks = rng.nextFloat() < 0.15;
      const count = rng.nextRange(1, 40);
      for (let k = 0; k < count; k++) {
        grid.setTile(rng.nextRange(0, N), rng.nextRange(0, N), blocks ? TileType.Stone : TileType.CorridorFloor);
      }
      live.invalidate();
      probe();
    }
  });

  it("reports zero region for non-walkable tiles", () => {
    const grid = new TileGrid(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) grid.setTile(x, y, TileType.Stone);
    }
    const map = new RegionMap(100, 100);
    expect(map.regionAt(grid, 5, 5)).toBe(0);
  });
});
