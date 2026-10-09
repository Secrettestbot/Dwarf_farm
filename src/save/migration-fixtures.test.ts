import { describe, it, expect } from "vitest";
import { importSaveFromJson } from "./transfer";
import { migrateSave } from "./migrations";
import { restore, snapshot } from "./snapshot";
import { CURRENT_SAVE_VERSION, SaveData } from "./schema";
import { tick } from "../sim/sim";
import { TileType } from "../sim/world/tiles";
import v2Text from "./fixtures/save-v2.json?raw";
import v3Text from "./fixtures/save-v3.json?raw";

// Hand-built saves in the shape older builds wrote (see the version
// history in schema.ts), stored in the export-file format so they go
// through the same import → migrate → restore path a player's backup
// would. Each one must come out as a working SimWorld that can keep
// ticking.

const FIXTURES: Array<{ name: string; text: string; version: number }> = [
  { name: "v2", text: v2Text, version: 2 },
  { name: "v3", text: v3Text, version: 3 },
];

function rawVersion(text: string): unknown {
  return (JSON.parse(text) as { save: { version: unknown } }).save.version;
}

describe.each(FIXTURES)("$name save fixture", ({ text, version }) => {
  it("is really stored at its old version", () => {
    expect(rawVersion(text)).toBe(version);
  });

  it("imports and migrates to the current version", () => {
    const save = importSaveFromJson(text);
    expect(save.version).toBe(CURRENT_SAVE_VERSION);
    // Migration is idempotent once at the current version.
    expect(migrateSave(save)).toEqual(save);
  });

  it("restores into a world that keeps ticking", () => {
    const save = importSaveFromJson(text);
    const sim = restore(save);
    expect(sim.tick).toBe(save.tick);
    expect(sim.dwarf.size()).toBe(3);
    // Tile overrides applied: the short corridor east of the founders' chamber.
    for (const x of [107, 108, 109]) expect(sim.grid.getTile(x, 28)).toBe(TileType.CorridorFloor);
    // Partnership restored by index.
    const ids: number[] = [];
    sim.forEachDwarf((id) => ids.push(id));
    expect(sim.dwarf.get(ids[0])!.partnerId).toBe(ids[1]);
    expect(sim.planner.blueprints.length).toBe(2);

    const startTick = sim.tick;
    for (let i = 0; i < 400; i++) tick(sim);
    expect(sim.tick).toBe(startTick + 400);
    expect(sim.dwarf.size()).toBeGreaterThan(0);

    // And the upgraded world saves cleanly at the current version.
    const resaved = snapshot({
      sim, slotId: save.slotId, fortressName: save.fortressName, mode: save.mode,
      cameraX: 0, cameraY: 0, zoomIndex: 1,
    });
    expect(resaved.version).toBe(CURRENT_SAVE_VERSION);
    expect(restore(resaved).tick).toBe(sim.tick);
  });

  it("restores deterministically", () => {
    const a = restore(importSaveFromJson(text));
    const b = restore(importSaveFromJson(text));
    for (let i = 0; i < 300; i++) { tick(a); tick(b); }
    const snap = (s: typeof a): Omit<SaveData, "realTimestampMs"> => {
      const { realTimestampMs, ...rest } = snapshot({
        sim: s, slotId: "x", fortressName: "x", mode: "legacy", cameraX: 0, cameraY: 0, zoomIndex: 1,
      });
      void realTimestampMs;
      return rest;
    };
    expect(snap(a)).toEqual(snap(b));
  });
});

describe("v2 fixture specifics", () => {
  it("has no fog mask, so the whole map restores as explored", () => {
    const sim = restore(importSaveFromJson(v2Text));
    expect(sim.grid.isSeen(0, 0)).toBe(true);
    expect(sim.grid.isSeen(199, 499)).toBe(true);
  });

  it("restores a dwarf saved with only the legacy `age` field", () => {
    const sim = restore(importSaveFromJson(v2Text));
    let kadolAge = -1;
    sim.forEachDwarf((id, _pos, dw) => { if (dw.name === "Kadol") kadolAge = sim.ageOf(id); });
    expect(kadolAge).toBe(30);
  });
});

describe("v3 fixture specifics", () => {
  it("drops the raw-id legacy fields on the way to v4", () => {
    const save = importSaveFromJson(v3Text) as SaveData & Record<string, unknown>;
    expect(save.hostileNames).toBeUndefined();
    expect(save.grudges).toBeUndefined();
    expect(save.caravan?.brokerId).toBeUndefined();
    expect(save.caravan?.origin).toBe("the Hold of Stoneholm");
  });

  it("restores the fog mask and resolves the legacy mayor by name", () => {
    const sim = restore(importSaveFromJson(v3Text));
    expect(sim.grid.isSeen(100, 28)).toBe(true);
    expect(sim.grid.isSeen(100, 300)).toBe(false);
    expect(sim.dwarf.get(sim.mayorId)?.name).toBe("Doren");
  });
});
