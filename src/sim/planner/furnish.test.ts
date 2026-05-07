import { describe, it, expect } from "vitest";
import { TileGrid } from "../world/grid";
import { TileType } from "../world/tiles";
import { Blueprint, rectCavity } from "./blueprint";
import { furnishRoom } from "./furnish";

function emptyGrid(): TileGrid {
  // 100×100 is the chunk size; all chunks default to Air.
  return new TileGrid(100, 100);
}

function bp(kind: Blueprint["kind"], x: number, y: number, w: number, h: number): Blueprint {
  return {
    id: 1,
    kind,
    originX: x,
    originY: y,
    width: w,
    height: h,
    cavity: rectCavity(x, y, w, h),
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
}

describe("furnishRoom", () => {
  it("places exactly one bed when furnishing a bedroom", () => {
    const g = emptyGrid();
    // Pre-fill cavity with CorridorFloor so we can detect tile changes.
    for (let y = 5; y < 8; y++) {
      for (let x = 10; x < 14; x++) g.setTile(x, y, TileType.CorridorFloor);
    }
    furnishRoom(g, bp("bedroom", 10, 5, 4, 3));
    let beds = 0;
    for (let y = 5; y < 8; y++) {
      for (let x = 10; x < 14; x++) {
        if (g.getTile(x, y) === TileType.Bed) beds++;
      }
    }
    expect(beds).toBe(1);
  });

  it("places multiple tables in a dining hall", () => {
    const g = emptyGrid();
    for (let y = 5; y < 10; y++) {
      for (let x = 5; x < 13; x++) g.setTile(x, y, TileType.CorridorFloor);
    }
    furnishRoom(g, bp("dining_hall", 5, 5, 8, 5));
    let tables = 0;
    for (let y = 5; y < 10; y++) {
      for (let x = 5; x < 13; x++) {
        if (g.getTile(x, y) === TileType.Table) tables++;
      }
    }
    expect(tables).toBeGreaterThanOrEqual(2);
  });

  it("places bins along the back wall of a stockpile", () => {
    const g = emptyGrid();
    for (let y = 5; y < 9; y++) {
      for (let x = 5; x < 10; x++) g.setTile(x, y, TileType.CorridorFloor);
    }
    furnishRoom(g, bp("stockpile", 5, 5, 5, 4));
    let bins = 0;
    for (let x = 5; x < 10; x++) {
      if (g.getTile(x, 5) === TileType.Bin) bins++;
    }
    expect(bins).toBeGreaterThanOrEqual(2);
  });

  it("leaves corridors and mines unfurnished", () => {
    const g = emptyGrid();
    for (let x = 10; x < 18; x++) g.setTile(x, 5, TileType.CorridorFloor);
    furnishRoom(g, bp("corridor", 10, 5, 8, 1));
    for (let x = 10; x < 18; x++) {
      expect(g.getTile(x, 5)).toBe(TileType.CorridorFloor);
    }
  });
});
