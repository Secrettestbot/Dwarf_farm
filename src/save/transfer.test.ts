import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { SimWorld } from "../sim/world/simWorld";
import { tick } from "../sim/sim";
import { snapshot, restore } from "./snapshot";
import { exportSaveToJson, importSaveFromJson } from "./transfer";
import { migrateSave } from "./migrations";
import { CURRENT_SAVE_VERSION, SaveData } from "./schema";

function makeSave(seed: number, ticks: number): SaveData {
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
    mode: "legacy" as SaveData["mode"],
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

describe("imported save validation", () => {
  // One real export, then mutate a field at a time.
  const good = JSON.parse(exportSaveToJson(makeSave(6607, 20))) as { encoding: string; save: Record<string, unknown> };
  const withSave = (patch: (s: Record<string, unknown>) => void): string => {
    const copy = JSON.parse(JSON.stringify(good)) as typeof good;
    patch(copy.save);
    return JSON.stringify(copy);
  };

  it("accepts an untouched export", () => {
    expect(() => importSaveFromJson(withSave(() => {}))).not.toThrow();
  });

  it.each([
    ["missing seed", (s: Record<string, unknown>) => { delete s.seed; }, /`seed` must be an integer/],
    ["string tick", (s: Record<string, unknown>) => { s.tick = "100"; }, /`tick` must be a non-negative integer/],
    ["negative tick", (s: Record<string, unknown>) => { s.tick = -5; }, /`tick` must be a non-negative integer/],
    ["zero width", (s: Record<string, unknown>) => { s.width = 0; }, /`width` must be a positive multiple of 100/],
    ["odd height", (s: Record<string, unknown>) => { s.height = 123; }, /`height` must be a positive multiple of 100/],
    ["huge world", (s: Record<string, unknown>) => { s.width = 10000; s.height = 10000; }, /exceeds the .*-tile limit/],
    ["unknown mode", (s: Record<string, unknown>) => { s.mode = "hardcore"; }, /`mode` must be "legacy" or "saga"/],
    ["dwarves not an array", (s: Record<string, unknown>) => { s.dwarves = {}; }, /`dwarves` must be an array/],
    ["nameless dwarf", (s: Record<string, unknown>) => { (s.dwarves as Record<string, unknown>[])[0].name = 7; }, /`dwarves\[0\]\.name` must be a string/],
    ["dwarf off the map", (s: Record<string, unknown>) => { (s.dwarves as Record<string, unknown>[])[0].x = 99999; }, /`dwarves\[0\]` position .* inside the world/],
    ["bad rng state", (s: Record<string, unknown>) => { (s.rngStates as Record<string, unknown>).ai = [1]; }, /`rngStates\.ai` must be a pair of integers/],
    ["odd blueprint cells", (s: Record<string, unknown>) => { s.blueprints = [{ id: 1, kind: "corridor", status: "digging", cells: [1, 2, 3] }]; }, /`blueprints\[0\]\.cells`/],
    ["missing version", (s: Record<string, unknown>) => { delete s.version; }, /`version` must be an integer/],
  ])("rejects %s with a readable error", (_label, patch, message) => {
    expect(() => importSaveFromJson(withSave(patch))).toThrow(/^Save file is invalid: /);
    expect(() => importSaveFromJson(withSave(patch))).toThrow(message);
  });

  it("reports several problems at once", () => {
    let err: Error | null = null;
    try {
      importSaveFromJson(withSave((s) => { delete s.seed; s.width = 7; }));
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/`seed`/);
    expect(err?.message).toMatch(/`width`/);
  });

  it("rejects terrain data whose header disagrees with the world size", () => {
    // Re-encode the overrides header for a 300-wide world.
    const text = withSave((s) => { s.width = 300; });
    expect(() => importSaveFromJson(text)).toThrow(/terrain data is for a 200×500 world but the save says 300×500/);
  });

  it("rejects corrupt base64 terrain data", () => {
    expect(() => importSaveFromJson(withSave((s) => { s.tileOverrides = "!!not base64!!"; }))).toThrow(/not valid base64/);
  });

  it("rejects truncated terrain data", () => {
    expect(() => importSaveFromJson(withSave((s) => { s.tileOverrides = "yAD0"; }))).toThrow(/truncated/);
  });
});

describe("save migrations", () => {
  it("upgrades a v3 save, dropping the unmappable raw-id fields", () => {
    const save = makeSave(6603, 100) as SaveData & Record<string, unknown>;
    save.version = 3;
    save.hostileNames = [{ id: 42, name: "Stale" }];
    save.grudges = [{ key: "3:9", count: 2, lastIncidentTick: 0 }];
    save.caravan = { x: 0, y: 0, leavesTick: 10, origin: "the Hold of Stoneholm", brokerId: 7 };
    const migrated = migrateSave(save) as SaveData & Record<string, unknown>;
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    expect(migrated.hostileNames).toBeUndefined();
    expect(migrated.grudges).toBeUndefined();
    expect((migrated.caravan as Record<string, unknown>).brokerId).toBeUndefined();
  });

  it("refuses saves with no version instead of guessing v2", () => {
    const save: Partial<SaveData> = makeSave(6609, 10);
    delete save.version;
    expect(() => migrateSave(save as SaveData)).toThrow(/no valid version number/i);
  });

  it("refuses v1 saves as too old", () => {
    const save = makeSave(6611, 10);
    save.version = 1;
    expect(() => migrateSave(save)).toThrow(/too old to load/i);
  });

  it("does not mutate the caller's object when upgrading v2", () => {
    const save = makeSave(6613, 10);
    save.version = 2;
    const migrated = migrateSave(save);
    expect(save.version).toBe(2);
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
  });

  it("refuses saves from a newer build", () => {
    const save = makeSave(6605, 10);
    save.version = CURRENT_SAVE_VERSION + 1;
    expect(() => migrateSave(save)).toThrow(/newer than this build/i);
  });
});
