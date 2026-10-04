import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";
import { chooseSafeZone } from "./systems/emergency";

function makeSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  return new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
}

function pin(sim: SimWorld): void {
  for (const e of sim.dwarf.entities) {
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
  }
}

/** Carve a finished 3×3 room joined to the spawn by a vertical shaft. */
function carveRoom(sim: SimWorld, id: number, depthBelowSpawn: number): Blueprint {
  const ox = sim.spawn.x + 4;
  const oy = sim.spawn.y + depthBelowSpawn;
  for (let y = sim.spawn.y; y < oy; y++) sim.grid.setTile(sim.spawn.x, y, TileType.CorridorFloor);
  for (let x = sim.spawn.x; x < ox; x++) sim.grid.setTile(x, oy, TileType.CorridorFloor);
  const cavity: number[] = [];
  for (let y = oy; y < oy + 3; y++) {
    for (let x = ox; x < ox + 3; x++) {
      cavity.push((y << 16) | x);
      sim.grid.setTile(x, y, TileType.CorridorFloor);
    }
  }
  sim.grid.setTile(ox, oy, TileType.Door);
  sim.regions.invalidate();
  const bp: Blueprint = {
    id, kind: "bedroom", originX: ox, originY: oy, width: 3, height: 3,
    cavity: new Int32Array(cavity), status: "complete", priority: 1, createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("emergency semantics", () => {
  it("picks the deepest reachable finished room as the Safe Zone", () => {
    const sim = makeSim(41);
    carveRoom(sim, 9001, 6);
    const deep = carveRoom(sim, 9002, 14);
    expect(chooseSafeZone(sim)?.id).toBe(deep.id);
  });

  it("evacuate sends soldiers to the Safe Zone too; alarm does not", () => {
    const sim = makeSim(43);
    const room = carveRoom(sim, 9003, 10);
    sim.spawnDwarf({ name: "Soldier", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    const soldier = sim.dwarf.entities[0];
    sim.squad.set(soldier, { draftedAtTick: 0 });
    pin(sim);
    sim.emergency.mode = "evacuate";
    sim.emergency.startedAtTick = sim.tick;
    tick(sim);
    const job = sim.job.get(soldier);
    expect(job?.kind).toBe("shelter");
    expect(job!.targetY).toBeGreaterThanOrEqual(room.originY);
    expect(sim.emergency.safeZoneId).toBe(room.id);
  });

  it("lockdown seals only surface openings and restores them on lift", () => {
    const sim = makeSim(47);
    const room = carveRoom(sim, 9004, 10);
    // An entrance shaft from the grass down to the founders' hall.
    const sx = sim.spawn.x;
    for (let y = sim.surfaceY[sx] + 1; y < sim.spawn.y; y++) sim.grid.setTile(sx, y, TileType.CorridorFloor);
    sim.regions.invalidate();
    const grassY = sim.surfaceY[sx];
    expect(sim.grid.isWalkable(sx, grassY)).toBe(true);
    const reachesSurface = () => sim.regions.connected(sim.grid, sim.spawn.x, sim.spawn.y, sx, grassY);
    expect(reachesSurface()).toBe(true);

    sim.emergency.mode = "lockdown";
    tick(sim);
    // The internal room door stays open and the room is still reachable…
    expect(sim.grid.getTile(room.originX, room.originY)).toBe(TileType.Door);
    expect(sim.regions.connected(sim.grid, sim.spawn.x, sim.spawn.y, room.originX + 1, room.originY + 1)).toBe(true);
    // …the surface itself is untouched, but the shaft to it is sealed.
    expect(sim.grid.isWalkable(sx, grassY)).toBe(true);
    expect(reachesSurface()).toBe(false);
    for (let i = 0; i < sim.emergency.sealed!.length; i += 3) {
      expect(sim.emergency.sealed![i + 1]).toBeGreaterThan(sim.surfaceY[sim.emergency.sealed![i]]);
    }

    sim.emergency.mode = "none";
    tick(sim);
    expect(reachesSurface()).toBe(true);
    expect(sim.emergency.sealed).toBeUndefined();
  });

  it("migrants camp outside a lockdown and come in when it lifts", () => {
    const sim = makeSim(53);
    sim.spawnDwarf({ name: "D", x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    sim.emergency.mode = "lockdown";
    // Force a camp as migrationSystem would on a successful roll.
    sim.emergency.migrantsCampUntil = sim.tick + 1000;
    const pop = sim.dwarf.size();
    pin(sim);
    tick(sim);
    expect(sim.dwarf.size()).toBe(pop);
    sim.emergency.mode = "none";
    tick(sim);
    expect(sim.dwarf.size()).toBeGreaterThan(pop);
    expect(sim.emergency.migrantsCampUntil).toBe(0);
  });
});
