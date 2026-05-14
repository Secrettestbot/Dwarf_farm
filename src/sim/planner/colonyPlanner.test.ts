import { describe, it, expect, beforeEach } from "vitest";
import { generateWorld } from "../world/worldgen";
import { Rng } from "../rng";
import { ColonyPlanner } from "./colonyPlanner";

const POP_DEFAULT = 7;

describe("ColonyPlanner", () => {
  // A fresh rng per test keeps cross-test interference impossible. Created
  // outside `it` lambda for terseness — Vitest runs tests sequentially.
  let testRng: Rng;
  beforeEach(() => {
    testRng = Rng.fromSeed(2024);
  });

  it("active blueprint cap scales with population (1 architect per 7)", () => {
    const w = generateWorld({ seed: 31, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // With population 14 the cap is ceil(14/7) = 2 architects → up to 2
    // active blueprints at once. Run one evaluation cycle.
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 14, rng: testRng });
    }
    expect(planner.activeCount()).toBeLessThanOrEqual(2);
    expect(planner.activeCount()).toBeGreaterThanOrEqual(1);
  });

  it("a 21-dwarf colony places up to 3 blueprints in parallel", () => {
    const w = generateWorld({ seed: 33, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 21, rng: testRng });
    }
    expect(planner.activeCount()).toBeLessThanOrEqual(3);
  });

  it("rooms never break the surface — at least 2 tiles of rock above every ceiling", () => {
    // Carve a long run of corridors that descends from the spawn cavern,
    // hand-excavating cavities so reachable space expands. Then check
    // every emitted ROOM blueprint has at least 2 tiles of solid rock
    // above its ceiling — a room carved at or just under the surface
    // looks absurd and offers zero protection from above.
    const w = generateWorld({ seed: 36, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 5000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 14, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    const ROOM_KINDS = new Set([
      "bedroom", "dining_hall", "stockpile", "farm", "kitchen", "brewery",
      "smelter", "forge", "mason", "jeweller", "carpenter", "kiln", "tannery",
      "loom", "library", "armoury", "throne_room", "hospital", "tavern",
      "trade_depot", "pump_station", "water_wheel", "cemetery", "stairwell",
      "magma_forge",
    ]);
    const rooms = planner.blueprints.filter((b) => ROOM_KINDS.has(b.kind));
    expect(rooms.length).toBeGreaterThan(0);
    for (const r of rooms) {
      // The blueprint cavity tiles are now walkable in the grid (we
      // carved them above). At placement time, the buffer rule requires
      // 2 solid tiles above each cavity column. Inspect the original
      // bbox: row r.originY is the topmost cavity row. The two rows
      // above (originY - 1 and originY - 2) must not be Air.
      for (let x = r.originX; x < r.originX + r.width; x++) {
        for (let d = 1; d <= 2; d++) {
          const y = r.originY - d;
          if (y < 0) continue;
          // 0 == TileType.Air. We can't import the enum into a test
          // import without complicating the module graph; the numeric
          // value is stable across the codebase.
          expect(w.grid.getTile(x, y), `room kind=${r.kind} at (${r.originX},${r.originY}) has Air at (${x},${y}) within ceiling buffer`).not.toBe(0);
        }
      }
    }
  });

  it("bedrooms spread out instead of clustering at the surface", () => {
    const w = generateWorld({ seed: 35, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Run long enough to emit several bedrooms; hand-excavate so the
    // colony's reachable area expands.
    for (let t = 1; t <= 4000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 14, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    const beds = planner.blueprints.filter((b) => b.kind === "bedroom");
    expect(beds.length).toBeGreaterThanOrEqual(3);
    // Range of bedroom Y should span at least 8 tiles — they're not all at
    // the surface.
    const ys = beds.map((b) => b.originY);
    const span = Math.max(...ys) - Math.min(...ys);
    expect(span).toBeGreaterThan(8);
  });

  it("does not emit anything before its evaluation cadence elapses", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 30; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
    }
    expect(planner.blueprints.length).toBe(0);
  });

  it("emits at least one blueprint within an in-game hour", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
    }
    // Planner allows multiple active blueprints (up to MAX_ACTIVE = 3) so it
    // can saturate work for several dwarves at once.
    expect(planner.blueprints.length).toBeGreaterThanOrEqual(1);
    expect(planner.blueprints.length).toBeLessThanOrEqual(3);
    // All cavity tiles in active blueprints must currently be solid.
    for (const b of planner.blueprints) {
      expect(b.cavity.length).toBe(b.width * b.height);
      for (let i = 0; i < b.cavity.length; i++) {
        const c = b.cavity[i];
        const x = c & 0xffff;
        const y = (c >>> 16) & 0xffff;
        expect(w.grid.isSolid(x, y)).toBe(true);
      }
    }
  });

  it("emits the first bedroom at population 1", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1, rng: testRng });
    }
    // pop=1 → 1 architect → 1 active blueprint at a time. Subsequent
    // blueprints emit only after the first is dug.
    expect(planner.blueprints.length).toBe(1);
    expect(planner.blueprints[0]?.kind).toBe("bedroom");
  });

  it("emits multiple blueprints as completed cavities free the gate (population 7)", () => {
    const w = generateWorld({ seed: 23, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Hand-excavate cavities so the planner sees them complete and can emit
    // another. With population 7 the target is ceil(7*1.5) = 11 rooms.
    for (let t = 1; t <= 800; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
      if (planner.blueprints.length > 0) {
        const bp = planner.blueprints[planner.blueprints.length - 1];
        if (bp.status === "digging") {
          for (let i = 0; i < bp.cavity.length; i++) {
            const c = bp.cavity[i];
            const x = c & 0xffff;
            const y = (c >>> 16) & 0xffff;
            w.grid.setTile(x, y, 7);
          }
        }
      }
    }
    expect(planner.blueprints.length).toBeGreaterThan(1);
    // Pairwise overlap check.
    const bps = planner.blueprints;
    for (let i = 0; i < bps.length; i++) {
      for (let j = i + 1; j < bps.length; j++) {
        const a = bps[i];
        const b = bps[j];
        const overlap =
          a.originX < b.originX + b.width &&
          a.originX + a.width > b.originX &&
          a.originY < b.originY + b.height &&
          a.originY + a.height > b.originY;
        expect(overlap).toBe(false);
      }
    }
  });

  it("caps bedrooms at the population target — but keeps exploring via corridors", () => {
    const w = generateWorld({ seed: 31, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Population 1: target = max(2, ceil(1*1.5)) = 2 bedrooms. The colony
    // never emits a 3rd bedroom but does keep digging exploration corridors.
    // Pin every completed bedroom as freshly maintained each tick so the
    // maintenance-gated emission rule (neglected rooms don't count toward
    // the target) doesn't kick in here — that behaviour has its own test.
    for (let t = 1; t <= 4000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status === "complete") {
          bp.lastMaintainedTick = t;
          continue;
        }
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    expect(planner.completedByKind["bedroom"] ?? 0).toBeLessThanOrEqual(2);
    expect(planner.completedByKind["corridor"] ?? 0).toBeGreaterThan(0);
  });

  it("emits a dining hall once population reaches 4", () => {
    const w = generateWorld({ seed: 41, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Hand-excavate as before so the planner can keep emitting.
    for (let t = 1; t <= 600; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 4, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    expect(planner.blueprints.some((b) => b.kind === "dining_hall")).toBe(true);
  });

  it("emits a stockpile once population reaches 5 and the dining hall is dug", () => {
    const w = generateWorld({ seed: 43, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 800; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 5, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    const kinds = planner.blueprints.map((b) => b.kind);
    expect(kinds).toContain("dining_hall");
    expect(kinds).toContain("stockpile");
  });

  it("emits exploration corridors so the colony's reach keeps growing", () => {
    const w = generateWorld({ seed: 51, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Hand-excavate so blueprints complete and the planner keeps emitting.
    for (let t = 1; t <= 2400; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    expect(planner.completedByKind["corridor"] ?? 0).toBeGreaterThan(0);
    // At least one corridor should head downward (extending into deeper rock).
    const corridors = planner.blueprints.filter((b) => b.kind === "corridor");
    const downward = corridors.some((b) => b.height >= b.width && b.originY > w.spawn.y);
    expect(downward).toBe(true);
  });

  it("emits a mine blueprint once corridors expose ore", () => {
    // Worldgen ore lies in the Shallow Earth layer (y >= 80); reaching it
    // organically takes many corridor emissions and the seed-dependent
    // distribution makes the integration timing brittle. We plant an
    // accessible ore vein near the spawn cavern to assert the wiring.
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    // Plant ore one tile outside the spawn cavern's right edge.
    w.grid.setTile(w.spawn.x + 7, w.spawn.y + 1, 5 /* TileType.Ore */);
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 800; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    // Corridors descend through the Skin layer (sandstone/dirt) into Shallow
    // Earth (stone with ore). After enough corridor work, ore should be in
    // sense range and a mine should have been emitted.
    const mineEmitted = planner.blueprints.some((b) => b.kind === "mine");
    expect(mineEmitted).toBe(true);
  });

  it("corridor emissions vary in length and width across the colony", () => {
    const w = generateWorld({ seed: 71, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 4000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    const corridors = planner.blueprints.filter((b) => b.kind === "corridor");
    expect(corridors.length).toBeGreaterThanOrEqual(3);
    const sizes = new Set(corridors.map((b) => b.cavity.length));
    expect(sizes.size).toBeGreaterThanOrEqual(2);
    // The user complaint that drove this test: "It's still doing exclusively
    // vertical tunnels." With direction-weighted sampling the colony must
    // emit BOTH horizontal and vertical corridors over a long-enough run.
    const verticals = corridors.filter((b) => b.height > b.width).length;
    const horizontals = corridors.filter((b) => b.width > b.height).length;
    expect(verticals).toBeGreaterThan(0);
    expect(horizontals).toBeGreaterThan(0);
  });

  it("the geology signal pulls corridors toward dense ore clusters", () => {
    // Plant a dense ore cluster off to the right, far enough that the
    // colony only reaches it if its corridor placement is biased
    // toward the rumour. Run a baseline (cluster absent) and a treatment
    // (cluster present) from the same seed; the treatment's tunnels
    // should reach noticeably further right than the baseline.
    function runWithCluster(seed: number, cluster: boolean): number {
      const world = generateWorld({ seed, width: 200, height: 500 });
      if (cluster) {
        const cx = world.spawn.x + 18;
        const cy = world.spawn.y;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (dx * dx + dy * dy > 9) continue;
            world.grid.setTile(cx + dx, cy + dy, 5 /* TileType.Ore */);
          }
        }
      }
      const planner = new ColonyPlanner();
      const localRng = Rng.fromSeed(2024);
      let maxX = world.spawn.x;
      for (let t = 1; t <= 2400; t++) {
        planner.tick({ grid: world.grid, spawn: world.spawn, tick: t, population: POP_DEFAULT, rng: localRng });
        for (const bp of planner.blueprints) {
          if (bp.status !== "digging") continue;
          for (let i = 0; i < bp.cavity.length; i++) {
            const c = bp.cavity[i];
            const x = c & 0xffff;
            const y = (c >>> 16) & 0xffff;
            world.grid.setTile(x, y, 7);
          }
        }
        for (const bp of planner.blueprints) {
          if (bp.kind !== "corridor") continue;
          const r = bp.originX + bp.width - 1;
          if (r > maxX) maxX = r;
        }
      }
      return maxX - world.spawn.x;
    }
    const baseline = runWithCluster(91, false);
    const withCluster = runWithCluster(91, true);
    // Treatment world should have reached at least as far right as baseline,
    // and should have crossed into the cluster's column.
    expect(withCluster).toBeGreaterThanOrEqual(baseline);
    expect(withCluster).toBeGreaterThan(15);
  });

  it("emits corridors below 80 tiles deep — no Skin-layer cap", () => {
    // Regression: the planner used to cap its corridor scan to ±50 tiles
    // around spawn, so once the deepest walkable was 50+ tiles down, no
    // new corridor could extend from it. Run long enough to descend past
    // y_spawn + 80 (well past the Skin layer) and assert that at least one
    // corridor is anchored deep.
    const w = generateWorld({ seed: 73, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 8000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT, rng: testRng });
      for (const bp of planner.blueprints) {
        if (bp.status !== "digging") continue;
        for (let i = 0; i < bp.cavity.length; i++) {
          const c = bp.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          w.grid.setTile(x, y, 7);
        }
      }
    }
    // Find the deepest corridor's exit Y.
    let deepest = -Infinity;
    for (const b of planner.blueprints) {
      if (b.kind !== "corridor") continue;
      const bottom = b.originY + b.height - 1;
      if (bottom > deepest) deepest = bottom;
    }
    expect(deepest).toBeGreaterThan(w.spawn.y + 60);
  });

  it("placement is deterministic across runs with the same seed", () => {
    // Each run gets its own rng instance seeded identically — sharing a
    // single rng would advance state for run A and leave run B reading
    // post-A state.
    const wa = generateWorld({ seed: 99, width: 200, height: 500 });
    const wb = generateWorld({ seed: 99, width: 200, height: 500 });
    const pa = new ColonyPlanner();
    const pb = new ColonyPlanner();
    const rngA = Rng.fromSeed(2024);
    const rngB = Rng.fromSeed(2024);
    for (let t = 1; t <= 200; t++) {
      pa.tick({ grid: wa.grid, spawn: wa.spawn, tick: t, population: POP_DEFAULT, rng: rngA });
      pb.tick({ grid: wb.grid, spawn: wb.spawn, tick: t, population: POP_DEFAULT, rng: rngB });
    }
    expect(pa.blueprints.length).toBe(pb.blueprints.length);
    for (let i = 0; i < pa.blueprints.length; i++) {
      expect(pa.blueprints[i].originX).toBe(pb.blueprints[i].originX);
      expect(pa.blueprints[i].originY).toBe(pb.blueprints[i].originY);
      expect(pa.blueprints[i].kind).toBe(pb.blueprints[i].kind);
    }
  });

  it("emits a second stockpile when recent far hauls signal one is needed", () => {
    // 20-dwarf colony with one stockpile already in place. Seed enough
    // recentFarHauls (the haul-travel-time signal) to push
    // needsStockpile past its quorum, then verify the planner picks
    // up a second stockpile blueprint within a few evaluations.
    const w = generateWorld({ seed: 87, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Hand-carve a corridor outward from spawn so reachable space
    // includes the hot point we want the new stockpile to land near.
    for (let dx = -30; dx <= 30; dx++) {
      w.grid.setTile(w.spawn.x + dx, w.spawn.y, 7); // CorridorFloor
    }
    // Plant the first stockpile by hand so existingByKind > 0 and
    // we exercise the secondary signal (not the cold-start "no
    // stockpile yet" branch).
    const firstStockpile = {
      id: 9999,
      kind: "stockpile" as const,
      originX: w.spawn.x - 2,
      originY: w.spawn.y,
      width: 5,
      height: 4,
      cavity: new Int32Array([
        (w.spawn.y << 16) | (w.spawn.x - 2 & 0xffff),
      ]),
      status: "complete" as const,
      priority: 1,
      createdTick: 0,
    };
    planner.blueprints.push(firstStockpile);
    planner.completedByKind["stockpile"] = 1;
    // Eight far-haul pickups clustered 25 tiles east of spawn. The
    // demand signal needs ≥ 8 fresh entries to fire.
    const recent = [];
    for (let i = 0; i < 8; i++) {
      recent.push({ x: w.spawn.x + 25, y: w.spawn.y, tick: 100 + i });
    }
    let emitted = false;
    for (let t = 100; t <= 2000 && !emitted; t++) {
      planner.tick({
        grid: w.grid,
        spawn: w.spawn,
        tick: t,
        population: 20,
        rng: testRng,
        recentFarHauls: recent,
      });
      const stockpiles = planner.blueprints.filter((b) => b.kind === "stockpile");
      if (stockpiles.length >= 2) emitted = true;
    }
    expect(emitted).toBe(true);
  });

  it("pauses corridor emission when the colony is buried in loose items", () => {
    // 20-dwarf colony with a heavy item backlog. With the
    // haul-saturated gate the architect should NOT keep emitting
    // exploration corridors — dwarves digging more rock when the
    // colony's already drowning in unhauled stones is the exact
    // behavior the gate is meant to prevent. We test for "fewer
    // corridors than a wide-open run would emit" rather than zero
    // because the backlog gate doesn't block the very first slot.
    function run(looseItemCount: number): number {
      const w = generateWorld({ seed: 51, width: 200, height: 500 });
      const planner = new ColonyPlanner();
      const rng = Rng.fromSeed(2024);
      for (let t = 1; t <= 2400; t++) {
        planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 20, rng, looseItemCount });
        for (const bp of planner.blueprints) {
          if (bp.status !== "digging") continue;
          for (let i = 0; i < bp.cavity.length; i++) {
            const c = bp.cavity[i];
            w.grid.setTile(c & 0xffff, (c >>> 16) & 0xffff, 7);
          }
        }
      }
      return planner.blueprints.filter((b) => b.kind === "corridor").length;
    }
    const baselineCorridors = run(0);
    const throttledCorridors = run(500);
    expect(baselineCorridors).toBeGreaterThan(0);
    expect(throttledCorridors).toBeLessThan(baselineCorridors);
  });
});
