import { describe, it, expect } from "vitest";
import { LAYER_TINTS, layerOf } from "./sprites";

describe("layer detection", () => {
  it("Skin → 0, Shallow Earth → 1, Deep Rock → 2 at GDD §5.1 thresholds", () => {
    const surfaceY = 27;
    expect(layerOf(surfaceY, surfaceY)).toBe(0);
    expect(layerOf(surfaceY + 79, surfaceY)).toBe(0);
    expect(layerOf(surfaceY + 80, surfaceY)).toBe(1);
    expect(layerOf(surfaceY + 299, surfaceY)).toBe(1);
    expect(layerOf(surfaceY + 300, surfaceY)).toBe(2);
    expect(layerOf(surfaceY + 699, surfaceY)).toBe(2);
    expect(layerOf(surfaceY + 700, surfaceY)).toBe(3);
    expect(layerOf(surfaceY + 1199, surfaceY)).toBe(3);
    expect(layerOf(surfaceY + 1200, surfaceY)).toBe(4);
    expect(layerOf(surfaceY + 1599, surfaceY)).toBe(4);
    expect(layerOf(surfaceY + 1600, surfaceY)).toBe(5);
    expect(layerOf(surfaceY + 5000, surfaceY)).toBe(5);
  });

  it("above the surface is treated as Skin (layer 0)", () => {
    expect(layerOf(0, 50)).toBe(0);
    expect(layerOf(40, 50)).toBe(0);
  });
});

describe("layer tint table", () => {
  it("layer 0 is identity (no shift)", () => {
    expect(LAYER_TINTS[0]).toEqual([1, 1, 1]);
  });

  it("deeper layers shift away from identity", () => {
    for (let i = 1; i < LAYER_TINTS.length; i++) {
      const t = LAYER_TINTS[i];
      const max = Math.max(t[0], t[1], t[2]);
      const min = Math.min(t[0], t[1], t[2]);
      // At least one channel must differ from neutral 1.0 by ≥ 5%.
      expect(Math.abs(max - 1) > 0.05 || Math.abs(min - 1) > 0.05).toBe(true);
    }
  });
});
