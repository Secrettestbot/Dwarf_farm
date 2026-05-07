import { describe, it, expect } from "vitest";
import { TileGrid } from "../world/grid";
import { TileType } from "../world/tiles";
import { AStar, unpackCell } from "./astar";

function emptyGrid(): TileGrid {
  const g = new TileGrid(100, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      g.setTile(x, y, TileType.CorridorFloor);
    }
  }
  return g;
}

describe("A*", () => {
  it("finds a direct path on an open grid", () => {
    const g = emptyGrid();
    const a = new AStar(100, 100);
    const path = a.findPath(g, 5, 5, 10, 10);
    expect(path).not.toBeNull();
    const start = unpackCell(path![0]);
    const end = unpackCell(path![path!.length - 1]);
    expect(start).toEqual({ x: 5, y: 5 });
    expect(end).toEqual({ x: 10, y: 10 });
  });

  it("returns null when blocked", () => {
    const g = emptyGrid();
    // Wall the goal.
    for (let y = 0; y < 100; y++) g.setTile(50, y, TileType.Stone);
    const a = new AStar(100, 100);
    expect(a.findPath(g, 5, 5, 95, 5)).toBeNull();
  });

  it("routes around obstacles", () => {
    const g = emptyGrid();
    for (let y = 5; y < 95; y++) g.setTile(50, y, TileType.Stone);
    const a = new AStar(100, 100);
    const path = a.findPath(g, 10, 50, 90, 50);
    expect(path).not.toBeNull();
    // Path must not cross x=50 row.
    for (let i = 0; i < path!.length; i++) {
      const c = unpackCell(path![i]);
      if (c.x === 50) expect(g.isWalkable(50, c.y)).toBe(true);
    }
  });

  it("can pathfind to the neighbor of a solid tile", () => {
    const g = emptyGrid();
    g.setTile(50, 50, TileType.Stone);
    const a = new AStar(100, 100);
    const path = a.findPathToNeighbor(g, 10, 10, 50, 50);
    expect(path).not.toBeNull();
    const last = unpackCell(path![path!.length - 1]);
    const dx = Math.abs(last.x - 50);
    const dy = Math.abs(last.y - 50);
    expect(Math.max(dx, dy)).toBe(1);
  });

  it("respects max nodes budget", () => {
    const g = emptyGrid();
    const a = new AStar(100, 100);
    // Tiny budget on a long path.
    expect(a.findPath(g, 0, 0, 99, 99, 5)).toBeNull();
  });
});
