import { describe, it, expect } from "vitest";
import { TileGrid } from "../world/grid";
import { TileType } from "../world/tiles";
import { RegionMap } from "./regionMap";

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

  it("reports zero region for non-walkable tiles", () => {
    const grid = new TileGrid(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) grid.setTile(x, y, TileType.Stone);
    }
    const map = new RegionMap(100, 100);
    expect(map.regionAt(grid, 5, 5)).toBe(0);
  });
});
