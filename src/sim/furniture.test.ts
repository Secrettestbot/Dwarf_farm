import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";
import { TICKS_PER_DAY } from "./time";

/** Plant a complete carpenter workshop next to spawn. */
function plantCarpenter(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      cavity.push((yy << 16) | xx);
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  // Workstation at the centre.
  sim.grid.setTile(ox + 1, oy + 1, TileType.CarpenterStation);
  const bp: Blueprint = {
    id: 9301,
    kind: "carpenter",
    originX: ox,
    originY: oy,
    width: 3,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

/** Plant a needs_furnishing bedroom blueprint. */
function plantBedroom(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 4; xx++) {
      cavity.push((yy << 16) | xx);
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  const bp: Blueprint = {
    id: 9302,
    kind: "bedroom",
    originX: ox,
    originY: oy,
    width: 4,
    height: 3,
    cavity: new Int32Array(cavity),
    status: "needs_furnishing",
    priority: 1,
    createdTick: 0,
    furniturePlaced: {},
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("furniture pipeline", () => {
  it("a needs_furnishing bedroom gets a bed delivered, then flips to complete", () => {
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const sim = new SimWorld(71, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Pre-built bed sitting at spawn — represents the founder
    // starter kit. Hauler should route this directly to the bedroom.
    sim.spawnItem({ kind: "bed", x: sx, y: sy });
    // Carve a corridor so the hauler can reach the bedroom.
    for (let xx = sx; xx <= sx + 6; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const bedroom = plantBedroom(sim, sx + 3, sy);
    // Spawn one hauling-capable dwarf.
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    // Pin needs so the dwarf doesn't wander off to eat / drink.
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (bedroom.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    // The cavity has a Bed tile.
    let bedFound = false;
    for (let i = 0; i < bedroom.cavity.length; i++) {
      const c = bedroom.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.Bed) { bedFound = true; break; }
    }
    expect(bedFound).toBe(true);
  });

  it("the carpenter actually crafts a bed when planks + a needs_furnishing bedroom are present", () => {
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    const sim = new SimWorld(73, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Carve a corridor so dwarves can move between workshop and bedroom.
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    plantCarpenter(sim, sx + 1, sy);
    const bedroom = plantBedroom(sim, sx + 7, sy);
    // Plenty of planks + a hauling/crafting dwarf.
    sim.stockpile.planks = 20;
    sim.spawnDwarf({ name: "Carp", x: sx, y: sy, age: 30, skills: { carpentry: 6 } });
    sim.spawnDwarf({ name: "Haul", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 4 && !placed; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
      if (bedroom.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
  });
});
