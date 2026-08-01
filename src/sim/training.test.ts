import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick, grudgeCount } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";
import { TICKS_PER_DAY } from "./time";

function plantRoom(sim: SimWorld, kind: Blueprint["kind"], stationTile: TileType | null, ox: number, oy: number): void {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      cavity.push((yy << 16) | xx);
    }
  }
  if (stationTile !== null) sim.grid.setTile(ox + 1, oy + 1, stationTile);
  sim.planner.blueprints.push({
    id: 9100 + sim.planner.blueprints.length,
    kind,
    originX: ox,
    originY: oy,
    width: 3,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
  });
}

describe("military training", () => {
  it("an idle soldier drills at the armoury and gains military XP", () => {
    const w = generateWorld({ seed: 7701, width: 200, height: 500 });
    const sim = new SimWorld(7701, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantRoom(sim, "armoury", TileType.ArmouryRack, w.spawn.x + 2, w.spawn.y - 1);
    const e = sim.spawnDwarf({ name: "Guard", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    sim.squad.set(e, { draftedAtTick: 0 });
    const xpBefore = sim.dwarf.get(e)!.skillXp.military ?? 0;
    let drilled = false;
    for (let i = 0; i < 300; i++) {
      tick(sim);
      if (sim.job.get(e)?.kind === "train") drilled = true;
    }
    expect(drilled).toBe(true);
    expect(sim.dwarf.get(e)!.skillXp.military ?? 0).toBeGreaterThan(xpBefore);
  });

  it("civilians do not drill", () => {
    const w = generateWorld({ seed: 7703, width: 200, height: 500 });
    const sim = new SimWorld(7703, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantRoom(sim, "armoury", TileType.ArmouryRack, w.spawn.x + 2, w.spawn.y - 1);
    const e = sim.spawnDwarf({ name: "Worker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
    for (let i = 0; i < 100; i++) {
      tick(sim);
      expect(sim.job.get(e)?.kind).not.toBe("train");
    }
  });
});

describe("grudge reconciliation", () => {
  it("a feud eventually ends over a tavern round", () => {
    const w = generateWorld({ seed: 7705, width: 200, height: 500 });
    const sim = new SimWorld(7705, w.grid, w.surfaceY, w.spawn);
    plantRoom(sim, "tavern", TileType.TavernCounter, w.spawn.x + 2, w.spawn.y - 1);
    const a = sim.spawnDwarf({ name: "Cael", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const b = sim.spawnDwarf({ name: "Drun", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    sim.grudges.set(a < b ? `${a}:${b}` : `${b}:${a}`, { count: 2, lastIncidentTick: 0 });
    let reconciled = false;
    // Jump day boundaries — the reconciliation roll is daily. Keep
    // morale topped up so the pair is in the mood to make peace.
    for (let day = 0; day < 120 && !reconciled; day++) {
      for (const id of [a, b]) {
        const n = sim.needs.get(id)!;
        n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; n.morale = 90;
      }
      sim.tick = (Math.floor(sim.tick / TICKS_PER_DAY) + 1) * TICKS_PER_DAY - 1;
      tick(sim);
      reconciled = grudgeCount(sim, a, b) === 0;
    }
    expect(reconciled).toBe(true);
    expect(sim.events.events.some((e) => /share a round at the tavern/.test(e.text))).toBe(true);
  });
});
