import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

describe("hauling", () => {
  it("mining drops a stone item entity at the mined location", () => {
    const w = generateWorld({ seed: 31, width: 200, height: 500 });
    const sim = new SimWorld(31, w.grid, w.surfaceY, w.spawn);
    // Plant a stone tile inside an active mine blueprint so the dwarf
    // actually digs it (chooseTask only mines what the planner has
    // committed the colony to).
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    sim.grid.setTile(sx + 1, sy, TileType.Stone);
    sim.planner.blueprints.push({
      id: 1,
      kind: "mine",
      originX: sx + 1,
      originY: sy,
      width: 1,
      height: 1,
      cavity: new Int32Array([(sy << 16) | (sx + 1)]),
      status: "digging",
      priority: 1,
      createdTick: 0,
    });
    sim.sliders.hauling = 0; // keep the dwarf focused on mining for this test
    sim.spawnDwarf({ name: "Borin", x: sx, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    let mined = false;
    for (let i = 0; i < 200 && !mined; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      mined = !sim.grid.isSolid(sx + 1, sy);
    }
    expect(mined).toBe(true);
    // The item dropped at the mined tile is a stone.
    let foundStone = false;
    for (const ie of sim.item.entities) {
      const it = sim.item.get(ie);
      const p = sim.position.get(ie);
      if (it?.kind === "stone" && p?.x === sx + 1 && p.y === sy) foundStone = true;
    }
    expect(foundStone).toBe(true);
  });

  it("hauling=0 keeps items on the floor (no haul jobs assigned)", () => {
    const w = generateWorld({ seed: 33, width: 200, height: 500 });
    const sim = new SimWorld(33, w.grid, w.surfaceY, w.spawn);
    sim.sliders.hauling = 0;
    sim.spawnItem({ kind: "stone", x: w.spawn.x + 1, y: w.spawn.y });
    sim.spawnDwarf({ name: "B", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    for (let i = 0; i < 60; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // The item is still there because no hauler is interested.
    expect(sim.item.entities.length).toBe(1);
  });

  it("a hauler picks up an item, walks it to the stockpile, and credits the counter", () => {
    const w = generateWorld({ seed: 35, width: 200, height: 500 });
    const sim = new SimWorld(35, w.grid, w.surfaceY, w.spawn);
    // Carve a stockpile next to the dwarf.
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    for (let xx = sx + 1; xx <= sx + 3; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    const cavity = new Int32Array([
      (sy << 16) | (sx + 2),
      (sy << 16) | (sx + 3),
    ]);
    sim.planner.blueprints.push({
      id: 1,
      kind: "stockpile",
      originX: sx + 2,
      originY: sy,
      width: 2,
      height: 1,
      cavity,
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Drop a loose stone next to the dwarf.
    sim.spawnItem({ kind: "stone", x: sx + 1, y: sy });
    sim.spawnDwarf({ name: "B", x: sx, y: sy, age: 30 });
    // Disable excavation so the planner's bedroom blueprint doesn't pull
    // the dwarf away into a mine-and-haul cycle that drowns out the test
    // signal — we want exactly one stone routed cleanly into the
    // stockpile, not "some stones eventually delivered."
    sim.sliders.excavation = 0;
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    const before = sim.stockpile.stone;
    for (let i = 0; i < 200; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.stockpile.stone).toBeGreaterThan(before);
    expect(sim.item.entities.length).toBe(0);
    expect(sim.carrying.has(e)).toBe(false);
  });

  it("a dwarf doesn't grind hauling XP on a non-counter item stored in the stockpile", () => {
    // Bug: when a non-counter item (e.g. a bed, with no
    // needs_furnishing bedroom waiting) sat inside a complete
    // stockpile cavity, an idle dwarf at that tile would pick it
    // up, find no destination, drop it back in place, and award
    // themselves hauling XP for the zero-tile round trip — over
    // and over while standing still. Two interlocking guards:
    // findHaulTarget skips items in a stockpile with no open
    // demand, and progressHaul.delivery refuses to award XP when
    // the pickup and drop tiles are the same.
    const w = generateWorld({ seed: 91, width: 200, height: 500 });
    const sim = new SimWorld(91, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Plant a 1-tile complete stockpile at (sx+1, sy) and a bed
    // entity sitting on it. No bedroom is in needs_furnishing, so
    // the bed has nowhere to go.
    sim.grid.setTile(sx + 1, sy, TileType.CorridorFloor);
    sim.planner.blueprints.push({
      id: 1,
      kind: "stockpile",
      originX: sx + 1,
      originY: sy,
      width: 1,
      height: 1,
      cavity: new Int32Array([(sy << 16) | (sx + 1)]),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    sim.spawnItem({ kind: "bed", x: sx + 1, y: sy });
    sim.sliders.excavation = 0;
    sim.spawnDwarf({ name: "Idle", x: sx + 1, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    const dw = sim.dwarf.get(e)!;
    const n = sim.needs.get(e)!;
    const haulingBefore = dw.skills.hauling ?? 0;
    for (let i = 0; i < 200; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    // Hauling skill must not have advanced — the bed had no demand
    // and the dwarf never moved.
    expect(dw.skills.hauling ?? 0).toBe(haulingBefore);
    // The bed should still be on the floor (not respawned dozens of
    // times nor consumed).
    let beds = 0;
    for (const ie of sim.item.entities) if (sim.item.get(ie)?.kind === "bed") beds++;
    expect(beds).toBe(1);
  });

  it("a needs_furnishing bed gets hauled before a closer counter-backed stone", () => {
    // With both a bed (furniture, room waiting) and a stone (bulk
    // counter-backed) within reach, the hauler should grab the bed
    // first — a bedroom blocked on its bed is more valuable than
    // one more stone in the pile. The stone is intentionally
    // placed closer to the dwarf so the test exercises the tier
    // bump rather than the nearest-wins tiebreak.
    const w = generateWorld({ seed: 67, width: 200, height: 500 });
    const sim = new SimWorld(67, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Carve a corridor so the dwarf can reach both items.
    for (let xx = sx; xx <= sx + 12; xx++) sim.grid.setTile(xx, sy, TileType.CorridorFloor);
    // Stone right next to the dwarf, bed three tiles away.
    sim.spawnItem({ kind: "stone", x: sx + 1, y: sy });
    sim.spawnItem({ kind: "bed", x: sx + 5, y: sy });
    // Plant a needs_furnishing bedroom so the bed has open demand.
    const bedroomOx = sx + 7;
    const cavity: number[] = [];
    for (let yy = sy; yy < sy + 3; yy++) {
      for (let xx = bedroomOx; xx < bedroomOx + 4; xx++) {
        cavity.push((yy << 16) | xx);
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    sim.planner.blueprints.push({
      id: 1,
      kind: "bedroom",
      originX: bedroomOx,
      originY: sy,
      width: 4,
      height: 3,
      cavity: new Int32Array(cavity),
      status: "needs_furnishing",
      priority: 1,
      createdTick: 0,
      furniturePlaced: {},
    });
    sim.sliders.excavation = 0;
    sim.spawnDwarf({ name: "H", x: sx, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    // Run until either item is picked up.
    for (let i = 0; i < 80; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      const carry = sim.carrying.get(e);
      if (carry) {
        expect(carry.kind).toBe("bed");
        return;
      }
    }
    throw new Error("dwarf never picked anything up");
  });

  it("active haulers are capped at roughly one per three dwarves", () => {
    // Plant a stockpile + many haul-bait stone items. With the cap
    // in place, only a fraction of the population can be hauling
    // simultaneously — the rest fall through to other tasks (or
    // wander). Without the cap the entire colony piles onto the
    // haul branch.
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const sim = new SimWorld(71, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Carve a wide reachable area and seed many stone items.
    for (let yy = sy - 3; yy <= sy + 3; yy++) {
      for (let xx = sx - 15; xx <= sx + 15; xx++) {
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    for (let i = 0; i < 30; i++) {
      sim.spawnItem({ kind: "stone", x: sx + (i % 10) - 5, y: sy + ((i / 10) | 0) - 1 });
    }
    // Plant a stockpile so haul delivery has a target.
    const cavity: number[] = [];
    for (let xx = sx + 8; xx < sx + 13; xx++) cavity.push((sy << 16) | xx);
    sim.planner.blueprints.push({
      id: 1,
      kind: "stockpile",
      originX: sx + 8,
      originY: sy,
      width: 5,
      height: 1,
      cavity: new Int32Array(cavity),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    sim.sliders.excavation = 0;
    // 12 generalist dwarves — none have hauling specialty, so all
    // are subject to the cap.
    for (let i = 0; i < 12; i++) {
      sim.spawnDwarf({ name: `H${i}`, x: sx + (i - 6), y: sy, age: 30 });
    }
    // Run a few ticks for chooseTask to assign jobs.
    for (let i = 0; i < 20; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    let haulers = 0;
    for (const id of sim.dwarf.entities) {
      if (sim.carrying.has(id)) { haulers++; continue; }
      const job = sim.job.get(id);
      if (job && job.kind === "haul") haulers++;
    }
    // Cap for pop=12 is floor(12/3) = 4. Allow a one-dwarf slack
    // in case the cap is checked at a slightly different state.
    expect(haulers).toBeLessThanOrEqual(5);
  });

  it("a wheelbarrow hauler sweeps stones from adjacent tiles in a single pickup", () => {
    // Without multi-tile pickup, a wheelbarrow at a mining face
    // grabs only the one stone at the target tile and walks back
    // with a near-empty barrow. Confirm the radius sweep grabs
    // stones from nearby tiles too, so a 3x3 mining cluster
    // clears in one trip.
    const w = generateWorld({ seed: 113, width: 200, height: 500 });
    const sim = new SimWorld(113, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    for (let yy = sy - 2; yy <= sy + 2; yy++) {
      for (let xx = sx - 3; xx <= sx + 3; xx++) {
        sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      }
    }
    // Plant a complete stockpile to the east so deliveries have a
    // counter to credit.
    const cavity: number[] = [];
    for (let xx = sx + 5; xx <= sx + 7; xx++) {
      sim.grid.setTile(xx, sy, TileType.CorridorFloor);
      cavity.push((sy << 16) | xx);
    }
    sim.planner.blueprints.push({
      id: 1,
      kind: "stockpile",
      originX: sx + 5,
      originY: sy,
      width: 3,
      height: 1,
      cavity: new Int32Array(cavity),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    // Seed the wheelbarrow pool so the haul can check one out.
    sim.stockpile.wheelbarrows = 1;
    // 9 stones in a 3x3 cluster centred on (sx+1, sy).
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        sim.spawnItem({ kind: "stone", x: sx + 1 + dx, y: sy + dy });
      }
    }
    sim.sliders.excavation = 0;
    sim.spawnDwarf({ name: "H", x: sx, y: sy, age: 30 });
    const e = sim.dwarf.entities[0];
    const n = sim.needs.get(e)!;
    // Run until carrying state shows a multi-item pickup.
    let maxStackCarried = 0;
    for (let i = 0; i < 80; i++) {
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      const c = sim.carrying.get(e);
      if (c && (c.count ?? 1) > maxStackCarried) maxStackCarried = c.count ?? 1;
    }
    // 9 stones, capacity = 8 (WHEELBARROW_CAPACITY / size 1).
    // Expect a near-full barrow on the first trip.
    expect(maxStackCarried).toBeGreaterThanOrEqual(2);
  });
});
