import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

function plantPumpRoom(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      cavity.push((yy << 16) | xx);
    }
  }
  sim.grid.setTile(ox + 1, oy + 1, TileType.PumpStation);
  const bp: Blueprint = {
    id: 9700,
    kind: "pump_station",
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

describe("pump station (GDD §10.2 Hydraulic Basics)", () => {
  it("a pump operator drains a nearby water tile", () => {
    const w = generateWorld({ seed: 901, width: 200, height: 500 });
    const sim = new SimWorld(901, w.grid, w.surfaceY, w.spawn);
    // Carve a corridor connecting spawn to the pump room.
    for (let xx = w.spawn.x; xx <= w.spawn.x + 6; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantPumpRoom(sim, w.spawn.x + 3, w.spawn.y - 1);
    // Plant a couple of water tiles in the corridor as a flooded zone.
    sim.grid.setTile(w.spawn.x + 1, w.spawn.y, TileType.Water);
    sim.grid.setTile(w.spawn.x + 2, w.spawn.y, TileType.Water);
    sim.spawnDwarf({ name: "Pumper", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    let drained = false;
    for (let i = 0; i < 400 && !drained; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      // Either water tile was reclaimed?
      const a = sim.grid.getTile(w.spawn.x + 1, w.spawn.y);
      const b = sim.grid.getTile(w.spawn.x + 2, w.spawn.y);
      if (a === TileType.CorridorFloor || b === TileType.CorridorFloor) drained = true;
    }
    expect(drained).toBe(true);
  });

  it("a pump room without nearby water doesn't tie up a dwarf", () => {
    const w = generateWorld({ seed: 903, width: 200, height: 500 });
    const sim = new SimWorld(903, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 6; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantPumpRoom(sim, w.spawn.x + 3, w.spawn.y - 1);
    // No water anywhere.
    sim.spawnDwarf({ name: "Slacker", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 50; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // Dwarf should not be on a pump job (no water means no work).
    expect(sim.job.get(e)?.kind).not.toBe("pump");
  });
});
