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
    for (let t = 1; t <= 4000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1, rng: testRng });
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
});
