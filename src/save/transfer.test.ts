import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { SimWorld } from "../sim/world/simWorld";
import { tick } from "../sim/sim";
import { snapshot, restore } from "./snapshot";
import { exportSaveToJson, importSaveFromJson } from "./transfer";
import { migrateSave } from "./migrations";
import { CURRENT_SAVE_VERSION, SaveV1 } from "./schema";

function makeSave(seed: number, ticks: number): SaveV1 {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < 5; i++) sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 25 });
  sim.stockpile.food = 100;
  sim.stockpile.drink = 100;
  for (let i = 0; i < ticks; i++) tick(sim);
  return snapshot({
    sim,
    slotId: "slot-transfer",
    fortressName: "Transfer Hold",
    mode: "legacy" as SaveV1["mode"],
    cameraX: 1,
    cameraY: 2,
    zoomIndex: 1,
  });
}

describe("save export/import", () => {
  it("survives an export → import round trip byte-identically", () => {
    const save = makeSave(6601, 500);
    const imported = importSaveFromJson(exportSaveToJson(save));
    expect(imported).toEqual(save);
    // And the imported save actually restores.
    const sim = restore(imported);
    expect(sim.dwarf.size()).toBeGreaterThan(0);
  });

  it("rejects non-save JSON with a readable error", () => {
    expect(() => importSaveFromJson('{"hello":"world"}')).toThrow(/not a dwarven deep save/i);
    expect(() => importSaveFromJson("garbage")).toThrow(/not json/i);
  });
});

describe("save migrations", () => {
  it("upgrades a v3 save, dropping the unmappable raw-id fields", () => {
    const save = makeSave(6603, 100) as SaveV1 & Record<string, unknown>;
    save.version = 3;
    save.hostileNames = [{ id: 42, name: "Stale" }];
    save.grudges = [{ key: "3:9", count: 2, lastIncidentTick: 0 }];
    save.caravan = { x: 0, y: 0, leavesTick: 10, origin: "the Hold of Stoneholm", brokerId: 7 };
    const migrated = migrateSave(save) as SaveV1 & Record<string, unknown>;
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    expect(migrated.hostileNames).toBeUndefined();
    expect(migrated.grudges).toBeUndefined();
    expect((migrated.caravan as Record<string, unknown>).brokerId).toBeUndefined();
  });

  it("refuses saves from a newer build", () => {
    const save = makeSave(6605, 10);
    save.version = CURRENT_SAVE_VERSION + 1;
    expect(() => migrateSave(save)).toThrow(/newer than this build/i);
  });
});
