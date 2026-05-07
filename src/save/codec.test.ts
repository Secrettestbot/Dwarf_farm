import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { TileType } from "../sim/world/tiles";
import { encodeOverrides, decodeOverrides } from "./codec";

describe("save codec", () => {
  it("round-trips with no changes producing a tiny payload", () => {
    const a = generateWorld({ seed: 1, width: 200, height: 500 });
    const b = generateWorld({ seed: 1, width: 200, height: 500 });
    const bytes = encodeOverrides(a.grid, b.grid);
    // No deltas: header (8 bytes) is the entire payload.
    expect(bytes.length).toBe(8);
    decodeOverrides(bytes).apply(b.grid);
  });

  it("preserves modifications across encode/decode", () => {
    const a = generateWorld({ seed: 42, width: 200, height: 500 });
    const baseline = generateWorld({ seed: 42, width: 200, height: 500 });

    // Mine some tiles in `a`.
    for (let i = 0; i < 50; i++) {
      a.grid.setTile(50 + i, 100, TileType.CorridorFloor);
    }
    const bytes = encodeOverrides(a.grid, baseline.grid);

    // Apply the delta to a fresh baseline regen.
    const restored = generateWorld({ seed: 42, width: 200, height: 500 });
    decodeOverrides(bytes).apply(restored.grid);
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
    const bytes = encodeOverrides(a.grid, baseline.grid);
    expect(bytes.length).toBeLessThan(2000);
  });
});
