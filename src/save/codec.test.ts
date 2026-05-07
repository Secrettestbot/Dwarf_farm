import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { TileType } from "../sim/world/tiles";
import { encodeOverrides, decodeOverrides } from "./codec";

describe("save codec", () => {
  it("round-trips with no changes producing a tiny payload", () => {
    const a = generateWorld({ seed: 1, width: 200, height: 500 });
    const b = generateWorld({ seed: 1, width: 200, height: 500 });
    const bytes = encodeOverrides(a.grid, b.grid, []);
    // Spawn-cavern carving makes a small delta vs raw pre-carve baseline; both
    // grids run carving so the delta should be 0. Header (8) + zones (2) = 10.
    expect(bytes.length).toBe(10);
    const decoded = decodeOverrides(bytes);
    decoded.apply(b.grid);
    expect(decoded.zones.length).toBe(0);
  });

  it("preserves modifications across encode/decode", () => {
    const a = generateWorld({ seed: 42, width: 200, height: 500 });
    const baseline = generateWorld({ seed: 42, width: 200, height: 500 });

    // Mine some tiles in `a`.
    for (let i = 0; i < 50; i++) {
      a.grid.setTile(50 + i, 100, TileType.CorridorFloor);
    }
    const zones = [{ x0: 10, y0: 30, x1: 40, y1: 60 }];
    const bytes = encodeOverrides(a.grid, baseline.grid, zones);

    // Apply the delta to a fresh baseline regen.
    const restored = generateWorld({ seed: 42, width: 200, height: 500 });
    const decoded = decodeOverrides(bytes);
    decoded.apply(restored.grid);
    expect(decoded.zones).toEqual(zones);
    for (let i = 0; i < 50; i++) {
      expect(restored.grid.getTile(50 + i, 100)).toBe(TileType.CorridorFloor);
    }
  });

  it("delta is small even after substantial mining", () => {
    const a = generateWorld({ seed: 5, width: 200, height: 500 });
    const baseline = generateWorld({ seed: 5, width: 200, height: 500 });
    // Carve a realistic-sized starter complex.
    for (let y = 30; y < 50; y++) {
      for (let x = 50; x < 100; x++) {
        a.grid.setTile(x, y, TileType.CorridorFloor);
      }
    }
    const bytes = encodeOverrides(a.grid, baseline.grid, []);
    expect(bytes.length).toBeLessThan(2000);
  });
});
