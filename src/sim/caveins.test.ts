import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint, BlueprintKind } from "./planner/blueprint";
import {
  CAVE_IN_SAFE_SPAN,
  caveInChance,
  caveInSystem,
  collapse,
  measureCeilingSpan,
  noteTileMined,
} from "./systems/caveIns";

function makeSim(seed = 4242): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  return new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
}

let nextBpId = 9100;

/** Carve a w×h chamber (CorridorFloor) sealed in Stone, registered as a
 * completed planner blueprint so its cells are planner-claimed. */
function carveRoom(sim: SimWorld, ox: number, oy: number, w: number, h: number, kind: BlueprintKind = "dining_hall"): Blueprint {
  for (let y = oy - 1; y <= oy + h; y++) {
    for (let x = ox - 1; x <= ox + w; x++) sim.grid.setTile(x, y, TileType.Stone);
  }
  const cavity: number[] = [];
  for (let y = oy; y < oy + h; y++) {
    for (let x = ox; x < ox + w; x++) {
      sim.grid.setTile(x, y, TileType.CorridorFloor);
      cavity.push((y << 16) | x);
    }
  }
  const bp: Blueprint = {
    id: nextBpId++,
    kind,
    originX: ox,
    originY: oy,
    width: w,
    height: h,
    cavity: new Int32Array(cavity),
    status: "complete",
    priority: 1,
    createdTick: 0,
  };
  sim.planner.blueprints.push(bp);
  sim.planner.rehydrate(sim.grid);
  sim.regions.invalidate();
  return bp;
}

function rubbleInRow(sim: SimWorld, x0: number, x1: number, y: number): number {
  let n = 0;
  for (let x = x0; x <= x1; x++) if (sim.grid.getTile(x, y) === TileType.Rubble) n++;
  return n;
}

describe("cave-ins", () => {
  it("rubble is solid, non-walkable rock", () => {
    const sim = makeSim();
    sim.grid.setTile(10, 300, TileType.Rubble);
    expect(sim.grid.isSolid(10, 300)).toBe(true);
    expect(sim.grid.isWalkable(10, 300)).toBe(false);
  });

  it("a wide unsupported span can collapse, filling the top row with rubble", () => {
    const sim = makeSim();
    const ox = sim.spawn.x - 10;
    const oy = sim.spawn.y + 80;
    carveRoom(sim, ox, oy, 20, 3, "great_hall");
    const cx = ox + 10;
    const span = measureCeilingSpan(sim, cx, oy + 2)!;
    expect(span.span).toBe(20);
    expect(span.ceilY).toBe(oy - 1);
    const p = caveInChance(sim, cx, span);
    expect(p).toBeGreaterThan(0);

    // Prime the region map so we can see it get invalidated.
    expect(sim.regions.regionAt(sim.grid, cx, oy)).not.toBe(0);

    let collapsedAt = -1;
    for (let t = 1; t <= 3000 && collapsedAt < 0; t++) {
      sim.tick = t;
      noteTileMined(sim, cx, oy + 2);
      caveInSystem(sim);
      if (rubbleInRow(sim, ox, ox + 19, oy) > 0) collapsedAt = t;
    }
    expect(collapsedAt).toBeGreaterThan(0);
    const n = rubbleInRow(sim, ox, ox + 19, oy);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(5);
    // Span ends and the lower rows are never filled.
    expect(sim.grid.getTile(ox, oy)).toBe(TileType.CorridorFloor);
    expect(sim.grid.getTile(ox + 19, oy)).toBe(TileType.CorridorFloor);
    expect(rubbleInRow(sim, ox, ox + 19, oy + 1)).toBe(0);
    expect(rubbleInRow(sim, ox, ox + 19, oy + 2)).toBe(0);
    // Region map was rebuilt: rubble is not walkable space, and the
    // chamber is still connected end to end along its floor.
    for (let x = ox; x < ox + 20; x++) {
      if (sim.grid.getTile(x, oy) === TileType.Rubble) {
        expect(sim.regions.regionAt(sim.grid, x, oy)).toBe(0);
      }
    }
    expect(sim.regions.connected(sim.grid, ox, oy + 2, ox + 19, oy + 2)).toBe(true);
    const ev = sim.events.events.find((e) => e.category === "crisis" && e.text.startsWith("Cave-in"));
    expect(ev).toBeDefined();
    expect(ev!.text).toContain("Great Hall");
  });

  it("softer ceilings and missing research make collapse likelier", () => {
    const sim = makeSim();
    const ox = sim.spawn.x - 10;
    const oy = sim.spawn.y + 80;
    carveRoom(sim, ox, oy, 14, 3);
    const span = measureCeilingSpan(sim, ox + 7, oy + 1)!;
    const stone = caveInChance(sim, ox + 7, span);
    sim.grid.setTile(ox + 7, oy - 1, TileType.Dirt);
    const dirt = caveInChance(sim, ox + 7, span);
    sim.grid.setTile(ox + 7, oy - 1, TileType.Granite);
    const granite = caveInChance(sim, ox + 7, span);
    expect(dirt).toBeGreaterThan(stone);
    expect(granite).toBeLessThan(stone);
    sim.grid.setTile(ox + 7, oy - 1, TileType.Stone);
    sim.research.completed.push("masonry_and_mortaring");
    expect(caveInChance(sim, ox + 7, span)).toBeCloseTo(stone / 2, 10);
    sim.research.completed.push("fortification_design");
    expect(caveInChance(sim, ox + 7, span)).toBeCloseTo(stone / 4, 10);
  });

  it("planner-sized rooms and one-tall corridors never collapse", () => {
    const sim = makeSim();
    // Widest planner room footprints: dining hall 8×5, great hall 6×4,
    // throne room 5×4, cemetery 5×5 — and a long 1-tall corridor.
    const rooms: [number, number, BlueprintKind][] = [
      [8, 5, "dining_hall"],
      [6, 4, "great_hall"],
      [5, 4, "throne_room"],
      [5, 5, "cemetery"],
      [30, 1, "corridor"],
    ];
    let oy = sim.spawn.y + 60;
    const all: { ox: number; oy: number; w: number; h: number }[] = [];
    for (const [w, h, kind] of rooms) {
      const ox = sim.spawn.x - 15;
      carveRoom(sim, ox, oy, w, h, kind);
      all.push({ ox, oy, w, h });
      oy += h + 3;
    }
    for (const r of all) {
      for (let y = r.oy; y < r.oy + r.h; y++) {
        for (let x = r.ox; x < r.ox + r.w; x++) {
          const s = measureCeilingSpan(sim, x, y);
          if (s) {
            expect(s.span).toBeLessThanOrEqual(CAVE_IN_SAFE_SPAN);
            expect(caveInChance(sim, x, s)).toBe(0);
          }
        }
      }
    }
    // Hammer every cell with "just mined" notes for a long stretch.
    for (let t = 1; t <= 2000; t++) {
      sim.tick = t;
      for (const r of all) {
        for (let y = r.oy; y < r.oy + r.h; y++) {
          for (let x = r.ox; x < r.ox + r.w; x++) noteTileMined(sim, x, y);
        }
      }
      caveInSystem(sim);
    }
    for (const r of all) {
      for (let y = r.oy; y < r.oy + r.h; y++) expect(rubbleInRow(sim, r.ox, r.ox + r.w - 1, y)).toBe(0);
    }
    expect(sim.events.events.some((e) => e.text.startsWith("Cave-in"))).toBe(false);
  });

  it("a normal planner-driven colony does not suffer cave-ins over a long run", () => {
    const seed = 42;
    const w = generateWorld({ seed, width: 200, height: 500 });
    const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 7; i++) sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 22 + i });
    for (let i = 0; i < 20_000; i++) tick(sim);
    expect(sim.planner.completed).toBeGreaterThan(0);
    expect(sim.events.events.some((e) => e.text.startsWith("Cave-in"))).toBe(false);
  });

  it("dwarves under a collapse are wounded or crushed, and a crisis is logged", () => {
    const sim = makeSim();
    const ox = sim.spawn.x - 10;
    const oy = sim.spawn.y + 80;
    carveRoom(sim, ox, oy, 20, 3);
    const cx = ox + 10;
    const frail = sim.spawnDwarf({ name: "Frail", x: cx, y: oy, age: 40 });
    const sturdy = sim.spawnDwarf({ name: "Sturdy", x: cx + 1, y: oy, age: 40 });
    const bystander = sim.spawnDwarf({ name: "Bystander", x: cx, y: oy + 2, age: 40 });
    sim.health.get(frail)!.hp = 1;
    const sturdyMax = sim.health.get(sturdy)!.maxHp;
    const span = measureCeilingSpan(sim, cx, oy + 2)!;
    // Radius bit set → 5-cell stretch (cx-2..cx+2).
    const filled = collapse(sim, cx, span, 0x100);
    expect(filled).toBe(3); // cx-2, cx-1, cx+2 — the dwarves' cells stay open

    expect(sim.ecs.isAlive(frail)).toBe(false);
    // The dead dwarf's cell holds their Memorial, not rubble.
    expect(sim.grid.getTile(cx, oy)).toBe(TileType.Memorial);
    if (sim.ecs.isAlive(sturdy)) {
      expect(sim.health.get(sturdy)!.hp).toBeLessThan(sturdyMax);
      expect(sim.grid.isWalkable(cx + 1, oy)).toBe(true);
    }
    // Out of the falling stretch: untouched.
    expect(sim.ecs.isAlive(bystander)).toBe(true);
    expect(sim.health.get(bystander)!.hp).toBe(sim.health.get(bystander)!.maxHp);

    const crises = sim.events.events.filter((e) => e.category === "crisis");
    expect(crises.some((e) => e.text.startsWith("Cave-in"))).toBe(true);
    expect(crises.some((e) => e.text.includes("Frail") && e.text.includes("crushed in a cave-in"))).toBe(true);
  });

  it("keeps mine-claim, job and item invariants intact", () => {
    const sim = makeSim();
    const ox = sim.spawn.x - 10;
    const oy = sim.spawn.y + 80;
    carveRoom(sim, ox, oy, 20, 3);
    const cx = ox + 10;
    // A miner (outside the falling stretch) holding a claim on the
    // ceiling rock right above the collapse.
    const miner = sim.spawnDwarf({ name: "Miner", x: ox + 1, y: oy + 2, age: 40 });
    sim.claimMineTarget(cx, oy - 1);
    sim.job.set(miner, { kind: "mine", targetX: cx, targetY: oy - 1, progress: 0 });
    // A hauler-ish job aimed at a cell that is about to be filled.
    const walker = sim.spawnDwarf({ name: "Walker", x: ox + 1, y: oy + 1, age: 40 });
    sim.job.set(walker, { kind: "maintain", targetX: cx - 1, targetY: oy, progress: 0 });
    // A loose item lying in the falling stretch.
    const item = sim.spawnItem({ kind: "stone", x: cx + 1, y: oy });

    const span = measureCeilingSpan(sim, cx, oy + 2)!;
    const filled = collapse(sim, cx, span, 0x100);
    expect(filled).toBe(5);

    for (const c of sim.mineClaims) {
      expect(sim.grid.isSolid(c & 0xffff, (c >>> 16) & 0xffff)).toBe(true);
    }
    expect(sim.job.get(miner)?.kind).toBe("mine");
    expect(sim.job.has(walker)).toBe(false);
    const ip = sim.position.get(item)!;
    expect(ip).toEqual({ x: cx + 1, y: oy + 1 });
    expect(sim.grid.isWalkable(ip.x, ip.y)).toBe(true);
    // Rubble is mineable rock inside the planner cavity, so a digging
    // colony will clear it.
    expect(sim.grid.isSolid(cx, oy)).toBe(true);
    expect(sim.planner.containsTile(sim.grid, cx, oy)).toBe(true);
  });
});
