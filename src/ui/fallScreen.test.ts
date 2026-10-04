import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { SimWorld } from "../sim/world/simWorld";
import { snapshot } from "../save/snapshot";
import { prepareRestoredSave } from "./fallScreen";

function makeSave(fallenAtTick?: number) {
  const w = generateWorld({ seed: 5, width: 200, height: 500 });
  const sim = new SimWorld(5, w.grid, w.surfaceY, w.spawn);
  return snapshot({
    sim,
    slotId: "slot0",
    fortressName: "Test",
    mode: "legacy",
    fallenAtTick,
    cameraX: 0,
    cameraY: 0,
    zoomIndex: 1,
  });
}

describe("fortress fall + restore points", () => {
  it("records fallenAtTick in the snapshot only when set", () => {
    expect(makeSave().fallenAtTick).toBeUndefined();
    expect(makeSave(1234).fallenAtTick).toBe(1234);
  });

  it("a restored checkpoint clears the fall and resets the wall clock", () => {
    const save = { ...makeSave(99), realTimestampMs: 1 };
    const restored = prepareRestoredSave(save, 5000);
    expect(restored.fallenAtTick).toBeUndefined();
    expect(restored.realTimestampMs).toBe(5000);
    // The original checkpoint record is untouched.
    expect(save.fallenAtTick).toBe(99);
  });
});
