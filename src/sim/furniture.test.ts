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

  it("a needs_furnishing dining hall takes a table delivery", () => {
    const w = generateWorld({ seed: 81, width: 200, height: 500 });
    const sim = new SimWorld(81, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "table", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 4; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    const hall: Blueprint = {
      id: 9311,
      kind: "dining_hall",
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
    sim.planner.blueprints.push(hall);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (hall.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
  });

  it("a needs_furnishing kitchen takes a stove delivery", () => {
    const w = generateWorld({ seed: 85, width: 200, height: 500 });
    const sim = new SimWorld(85, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "stove", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 3; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    sim.grid.setTile(ox + 1, oy + 1, TileType.KitchenStation);
    const kitchen: Blueprint = {
      id: 9313,
      kind: "kitchen",
      originX: ox,
      originY: oy,
      width: 3,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    };
    sim.planner.blueprints.push(kitchen);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (kitchen.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    let stoveFound = false;
    for (let i = 0; i < kitchen.cavity.length; i++) {
      const c = kitchen.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.Stove) { stoveFound = true; break; }
    }
    expect(stoveFound).toBe(true);
  });

  it("a needs_furnishing stockpile takes a bin delivery", () => {
    const w = generateWorld({ seed: 83, width: 200, height: 500 });
    const sim = new SimWorld(83, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "bin", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 3; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    const sp: Blueprint = {
      id: 9312,
      kind: "stockpile",
      originX: ox,
      originY: oy,
      width: 3,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    };
    sim.planner.blueprints.push(sp);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (sp.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
  });

  it("a needs_furnishing brewery gets a barrel delivered, then flips to complete", () => {
    const w = generateWorld({ seed: 75, width: 200, height: 500 });
    const sim = new SimWorld(75, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Pre-built barrel at spawn — represents a starter-kit barrel.
    sim.spawnItem({ kind: "barrel", x: sx, y: sy });
    // Carve a corridor so the hauler can reach the brewery.
    for (let xx = sx; xx <= sx + 6; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    // Hand-plant a needs_furnishing brewery with its workstation stamped.
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 3; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    sim.grid.setTile(ox + 1, oy + 1, TileType.BreweryStation);
    const brewery: Blueprint = {
      id: 9303,
      kind: "brewery",
      originX: ox,
      originY: oy,
      width: 3,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    };
    sim.planner.blueprints.push(brewery);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (brewery.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    // The cavity now has a BrewingBarrel tile somewhere.
    let barrelFound = false;
    for (let i = 0; i < brewery.cavity.length; i++) {
      const c = brewery.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.BrewingBarrel) { barrelFound = true; break; }
    }
    expect(barrelFound).toBe(true);
  });

  it("a needs_furnishing mason workshop takes a mason_bench delivery and stamps the station tile", () => {
    const w = generateWorld({ seed: 87, width: 200, height: 500 });
    const sim = new SimWorld(87, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "mason_bench", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 3; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    // Slice 8: the MasonStation tile is NOT stamped up front — the
    // mason_bench delivery is what creates it.
    const shop: Blueprint = {
      id: 9320,
      kind: "mason",
      originX: ox,
      originY: oy,
      width: 3,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    };
    sim.planner.blueprints.push(shop);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (shop.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    let stationFound = false;
    for (let i = 0; i < shop.cavity.length; i++) {
      const c = shop.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.MasonStation) { stationFound = true; break; }
    }
    expect(stationFound).toBe(true);
  });

  it("a needs_furnishing farm takes a seed_bag delivery and stamps every cavity cell as FarmTile", () => {
    const w = generateWorld({ seed: 91, width: 200, height: 500 });
    const sim = new SimWorld(91, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "seed_bag", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 4; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    const farm: Blueprint = {
      id: 9330,
      kind: "farm",
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
    sim.planner.blueprints.push(farm);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (farm.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    // Every cavity cell should now be a FarmTile, and cellTendedAt
    // should be initialised parallel to the cavity.
    for (let i = 0; i < farm.cavity.length; i++) {
      const c = farm.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      expect(sim.grid.getTile(x, y)).toBe(TileType.FarmTile);
    }
    expect(farm.cellTendedAt).toBeTruthy();
    expect(farm.cellTendedAt!.length).toBe(farm.cavity.length);
  });

  it("a needs_furnishing water wheel takes an axle delivery and stamps every cavity cell as WaterWheel", () => {
    const w = generateWorld({ seed: 93, width: 200, height: 500 });
    const sim = new SimWorld(93, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "water_wheel_axle", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 2; yy++) {
      for (let xx = ox; xx < ox + 3; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    const wheel: Blueprint = {
      id: 9340,
      kind: "water_wheel",
      originX: ox,
      originY: oy,
      width: 3,
      height: 2,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    };
    sim.planner.blueprints.push(wheel);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (wheel.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    for (let i = 0; i < wheel.cavity.length; i++) {
      const c = wheel.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      expect(sim.grid.getTile(x, y)).toBe(TileType.WaterWheel);
    }
  });

  it("a needs_furnishing trade depot takes a trade_scales delivery", () => {
    const w = generateWorld({ seed: 95, width: 200, height: 500 });
    const sim = new SimWorld(95, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.spawnItem({ kind: "trade_scales", x: sx, y: sy });
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const ox = sx + 3;
    const oy = sy;
    const cavity: number[] = [];
    for (let yy = oy; yy < oy + 3; yy++) {
      for (let xx = ox; xx < ox + 3; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    const depot: Blueprint = {
      id: 9350,
      kind: "trade_depot",
      originX: ox,
      originY: oy,
      width: 3,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    };
    sim.planner.blueprints.push(depot);
    sim.spawnDwarf({ name: "Hauler", x: sx, y: sy, age: 30 });
    let placed = false;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !placed; i++) {
      const id = sim.dwarf.entities[0];
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (depot.status === "complete") placed = true;
    }
    expect(placed).toBe(true);
    let scalesFound = false;
    for (let i = 0; i < depot.cavity.length; i++) {
      const c = depot.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.TradeScales) { scalesFound = true; break; }
    }
    expect(scalesFound).toBe(true);
  });
});
