import { describe, it, expect, beforeEach } from "vitest";
import { LAYER_TINTS, layerOf, getDwarfSprite, setSpriteSet, getSpriteSet } from "./sprites";

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

describe("dwarf sprite pool dispatch", () => {
  // Reset to the default pool between tests so state from earlier
  // cases doesn't leak — setSpriteSet invalidates the cached pool
  // so each call to getDwarfSprite rebuilds from scratch.
  beforeEach(() => setSpriteSet("dwarves"));

  it("returns the same sprite for the same dwarf id every call", () => {
    const a = getDwarfSprite(42);
    const b = getDwarfSprite(42);
    expect(a).toBe(b);
  });

  it("returns different sprites for at least some different ids", () => {
    // Sample a handful of ids and check we get more than one
    // distinct sprite canvas — a deterministic hash hitting the
    // same pool entry every time would be a regression.
    const seen = new Set<unknown>();
    for (let id = 0; id < 32; id++) seen.add(getDwarfSprite(id));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("getSpriteSet reflects what setSpriteSet last applied", () => {
    setSpriteSet("bunnies");
    expect(getSpriteSet()).toBe("bunnies");
    setSpriteSet("mixed");
    expect(getSpriteSet()).toBe("mixed");
  });

  it("bunnies-only pool produces sprites different from the dwarves-only pool", () => {
    setSpriteSet("dwarves");
    const dwarfSprite = getDwarfSprite(0);
    setSpriteSet("bunnies");
    const bunnySprite = getDwarfSprite(0);
    // The two pools are disjoint, so the same id can't possibly
    // map to the same canvas object.
    expect(dwarfSprite).not.toBe(bunnySprite);
  });
});
