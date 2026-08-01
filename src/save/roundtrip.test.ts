import { describe, it, expect } from "vitest";
import { generateWorld } from "../sim/world/worldgen";
import { SimWorld } from "../sim/world/simWorld";
import { tick, grudgeCount } from "../sim/sim";
import { snapshot, restore } from "./snapshot";
import { SaveV1 } from "./schema";

/** Build a small colony and run it long enough that most systems have
 * fired: jobs, hauling, planner emissions, hostiles, events. Stocked
 * food/drink keeps the founders alive for the whole window. */
function buildAndRun(seed: number, ticks: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < 7; i++) {
    sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 25 + i });
  }
  sim.stockpile.food = 200;
  sim.stockpile.drink = 200;
  for (let i = 0; i < ticks; i++) tick(sim);
  return sim;
}

function takeSnapshot(sim: SimWorld): SaveV1 {
  return snapshot({
    sim,
    slotId: "slot-test",
    fortressName: "Roundtrip Hold",
    mode: "standard" as SaveV1["mode"],
    cameraX: 0,
    cameraY: 0,
    zoomIndex: 1,
  });
}

/** Drop the wall-clock timestamp — the only field allowed to differ. */
function strip(save: SaveV1): Omit<SaveV1, "realTimestampMs"> {
  const { realTimestampMs, ...rest } = save;
  void realTimestampMs;
  return rest;
}

describe("simulation determinism", () => {
  it("two sims with the same seed produce identical state after 3000 ticks", () => {
    const a = buildAndRun(4242, 3000);
    const b = buildAndRun(4242, 3000);
    expect(strip(takeSnapshot(a))).toEqual(strip(takeSnapshot(b)));
  });
});

describe("save round-trip", () => {
  it("snapshot(restore(snapshot(sim))) is byte-identical to snapshot(sim)", () => {
    const sim = buildAndRun(777, 3000);
    const s1 = takeSnapshot(sim);
    const sim2 = restore(s1);
    const s2 = takeSnapshot(sim2);
    expect(strip(s2)).toEqual(strip(s1));
  });

  it("entity references survive a round trip even after deaths shift ids", () => {
    const sim = buildAndRun(31, 500);
    // Kill a founder so the original sim's entity ids have a gap the
    // restored sim's fresh sequential ids won't reproduce — any field
    // that saves raw entity ids instead of dwarves-array indexes will
    // point at the wrong dwarf after restore.
    const victim = sim.dwarf.entities[2];
    sim.needs.get(victim)!.thirst = 0;
    tick(sim);
    expect(sim.dwarf.size()).toBe(6);
    // entities[2] is the swap-remove replacement — the dwarf whose id
    // most reliably differs between the original and restored sims.
    const a = sim.dwarf.entities[2];
    const b = sim.dwarf.entities[4];
    const aName = sim.dwarf.get(a)!.name;
    const bName = sim.dwarf.get(b)!.name;
    sim.grudges.set(a < b ? `${a}:${b}` : `${b}:${a}`, { count: 5, lastIncidentTick: sim.tick });
    const gob = sim.spawnHostile({ kind: "goblin_warlord", x: sim.spawn.x + 3, y: sim.spawn.y });
    sim.hostileNames.set(gob, "Drogmar Black-Tongue");
    sim.caravanX = sim.spawn.x;
    sim.caravanY = sim.spawn.y;
    sim.caravanLeavesTick = sim.tick + 1000;
    sim.caravanOrigin = "the Hold of Stoneholm";
    sim.caravanBrokerId = b;
    sim.caravanDealResource = "stone";
    sim.caravanDealCost = 5;
    sim.caravanDealImport = "food";
    sim.caravanDealGain = 10;

    const sim2 = restore(takeSnapshot(sim));
    const find = (name: string) =>
      sim2.dwarf.entities.find((id) => sim2.dwarf.get(id)!.name === name)!;
    const a2 = find(aName);
    const b2 = find(bName);
    expect(grudgeCount(sim2, a2, b2)).toBe(5);
    const gob2 = sim2.hostile.entities.find((id) => sim2.hostile.get(id)!.kind === "goblin_warlord")!;
    expect(sim2.hostileNames.get(gob2)).toBe("Drogmar Black-Tongue");
    expect(sim2.caravanBrokerId).toBe(b2);
  });
});
