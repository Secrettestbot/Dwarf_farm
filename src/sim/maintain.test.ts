import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { Rng } from "./rng";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { ColonyPlanner } from "./planner/colonyPlanner";
import {
  Blueprint,
  isMaintainable,
  isRoomNeglected,
  MAINTAIN_VALIDITY_TICKS,
} from "./planner/blueprint";

/** Plant a synthetic completed bedroom in the sim. Mirrors what the planner
 * would produce after a finished dig, but lets the test pin location, size,
 * and last-maintained tick directly. */
function plantBedroom(
  sim: SimWorld,
  originX: number,
  originY: number,
  w: number,
  h: number,
  lastMaintainedTick = 0,
): Blueprint {
  const cavity = new Int32Array(w * h);
  let i = 0;
  for (let yy = originY; yy < originY + h; yy++) {
    for (let xx = originX; xx < originX + w; xx++) {
      cavity[i++] = (yy << 16) | xx;
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  const bp: Blueprint = {
    id: 7000 + sim.planner.blueprints.length,
    kind: "bedroom",
    originX,
    originY,
    width: w,
    height: h,
    cavity,
    status: "complete",
    priority: 1,
    createdTick: 0,
    lastMaintainedTick,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("room maintenance", () => {
  it("isMaintainable identifies habitable rooms only", () => {
    expect(isMaintainable("bedroom")).toBe(true);
    expect(isMaintainable("dining_hall")).toBe(true);
    expect(isMaintainable("stockpile")).toBe(true);
    expect(isMaintainable("farm")).toBe(true);
    // Bare passages don't decay.
    expect(isMaintainable("corridor")).toBe(false);
    expect(isMaintainable("mine")).toBe(false);
    expect(isMaintainable("stairwell")).toBe(false);
  });

  it("isRoomNeglected flips once the validity window elapses on a complete room", () => {
    const cavity = new Int32Array([0]);
    const fresh: Blueprint = {
      id: 1,
      kind: "bedroom",
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      cavity,
      status: "complete",
      priority: 1,
      createdTick: 0,
      lastMaintainedTick: 1000,
    };
    expect(isRoomNeglected(fresh, 1000 + MAINTAIN_VALIDITY_TICKS - 1)).toBe(false);
    expect(isRoomNeglected(fresh, 1000 + MAINTAIN_VALIDITY_TICKS + 1)).toBe(true);
  });

  it("isRoomNeglected never flags an in-progress dig", () => {
    const digging: Blueprint = {
      id: 1,
      kind: "bedroom",
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      cavity: new Int32Array([0]),
      status: "digging",
      priority: 1,
      createdTick: 0,
    };
    expect(isRoomNeglected(digging, 9999999)).toBe(false);
  });

  it("isRoomNeglected ignores bare passages even when they are old", () => {
    const corridor: Blueprint = {
      id: 1,
      kind: "corridor",
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      cavity: new Int32Array([0]),
      status: "complete",
      priority: 1,
      createdTick: 0,
    };
    expect(isRoomNeglected(corridor, MAINTAIN_VALIDITY_TICKS * 10)).toBe(false);
  });

  it("a neglected bedroom does not count toward the architect's room target", () => {
    // Plant two ancient completed bedrooms. Their staleness should mean
    // the architect treats the maintained-bedroom count as zero and emits
    // a fresh blueprint despite already having two on the books. We use
    // pop=2 so two architects work in parallel — the existing in-flight
    // dig doesn't block the gate.
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(71);
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 2, rng });
      // Hand-excavate so emitted bedrooms complete and free the active slot.
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          w.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, TileType.CorridorFloor);
        }
      }
    }
    // Inject two ancient completed bedrooms by hand on top of whatever the
    // planner produced. Together they would meet the cap if they counted.
    for (let k = 0; k < 2; k++) {
      const cav = new Int32Array(12);
      const ox = w.spawn.x + 30 + k * 10;
      const oy = w.spawn.y;
      let i = 0;
      for (let yy = oy; yy < oy + 3; yy++) {
        for (let xx = ox; xx < ox + 4; xx++) {
          cav[i++] = (yy << 16) | xx;
          w.grid.setTile(xx, yy, TileType.CorridorFloor);
        }
      }
      planner.blueprints.push({
        id: 9000 + k,
        kind: "bedroom",
        originX: ox,
        originY: oy,
        width: 4,
        height: 3,
        cavity: cav,
        status: "complete",
        priority: 1,
        createdTick: 0,
        lastMaintainedTick: -1_000_000,
      });
    }
    const bedroomsBefore = planner.blueprints.filter((b) => b.kind === "bedroom").length;
    // Excavate any digging blueprint each tick so the active slot stays
    // free and the architect can emit the maintenance-driven replacement.
    let emitted = false;
    for (let t = 61; t <= 4000 && !emitted; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 2, rng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          w.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, TileType.CorridorFloor);
        }
      }
      const beds = planner.blueprints.filter((b) => b.kind === "bedroom");
      if (beds.length > bedroomsBefore) emitted = true;
    }
    expect(emitted).toBe(true);
  });

  it("a freshly-maintained bedroom still counts toward the cap (no respawn)", () => {
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    const rng = Rng.fromSeed(73);
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1, rng });
    }
    // Inject two well-maintained bedrooms by hand, with their lastMaintainedTick
    // pinned to "now" each iteration so neglect never bites.
    const ids: number[] = [];
    for (let k = 0; k < 2; k++) {
      const cav = new Int32Array(12);
      const ox = w.spawn.x + 20 + k * 10;
      const oy = w.spawn.y;
      let i = 0;
      for (let yy = oy; yy < oy + 3; yy++) {
        for (let xx = ox; xx < ox + 4; xx++) {
          cav[i++] = (yy << 16) | xx;
          w.grid.setTile(xx, yy, TileType.CorridorFloor);
        }
      }
      const id = 9100 + k;
      ids.push(id);
      planner.blueprints.push({
        id,
        kind: "bedroom",
        originX: ox,
        originY: oy,
        width: 4,
        height: 3,
        cavity: cav,
        status: "complete",
        priority: 1,
        createdTick: 0,
        lastMaintainedTick: 60,
      });
    }
    const bedroomsBefore = planner.blueprints.filter((b) => b.kind === "bedroom").length;
    for (let t = 61; t <= 4000; t++) {
      // Simulate an industrious dwarf: bedrooms stay maintained.
      for (const b of planner.blueprints) {
        if (ids.includes(b.id)) b.lastMaintainedTick = t;
      }
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1, rng });
    }
    const bedroomsAfter = planner.blueprints.filter((b) => b.kind === "bedroom").length;
    // pop=1 → bedroom target = max(2, 2) = 2. With the two we injected
    // both kept maintained, the architect should not emit a third.
    expect(bedroomsAfter).toBe(bedroomsBefore);
  });

  it("a dwarf maintains a neglected bedroom and stamps its lastMaintainedTick", () => {
    const w = generateWorld({ seed: 79, width: 200, height: 500 });
    const sim = new SimWorld(79, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Cap survival needs so chooseTask doesn't divert to drink/eat/sleep
    // during the run — the work we want to test is maintenance.
    const dEnt = sim.dwarf.entities[0];
    const needs = sim.needs.get(dEnt)!;
    needs.hunger = 100;
    needs.thirst = 100;
    needs.sleep = 100;
    needs.social = 100;
    // Plant a neglected bedroom near spawn so the dwarf can reach it.
    const bp = plantBedroom(sim, w.spawn.x + 2, w.spawn.y, 3, 2, -1_000_000);
    expect(isRoomNeglected(bp, sim.tick)).toBe(true);
    // Run long enough for the dwarf to walk + complete a maintain job.
    for (let i = 0; i < 200; i++) {
      // Re-pin needs each tick — needs decay would otherwise let thirst
      // overrule maintenance partway through.
      needs.hunger = 100;
      needs.thirst = 100;
      needs.sleep = 100;
      needs.social = 100;
      tick(sim);
    }
    expect(isRoomNeglected(bp, sim.tick)).toBe(false);
  });

  it("mining is deferred while a maintainable room is neglected", () => {
    // The whole point of the maintenance gate is that a colony can't sprawl
    // while existing rooms rot. Dwarves should pick up the maintain task in
    // preference to mining.
    const w = generateWorld({ seed: 83, width: 200, height: 500 });
    const sim = new SimWorld(83, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const dEnt = sim.dwarf.entities[0];
    const needs = sim.needs.get(dEnt)!;
    needs.hunger = 100;
    needs.thirst = 100;
    needs.sleep = 100;
    needs.social = 100;
    plantBedroom(sim, w.spawn.x + 2, w.spawn.y, 3, 2, -1_000_000);
    // One tick is enough to assign a job from chooseTask.
    needs.hunger = 100;
    needs.thirst = 100;
    needs.sleep = 100;
    needs.social = 100;
    tick(sim);
    const job = sim.job.get(dEnt);
    expect(job?.kind).toBe("maintain");
  });
});
