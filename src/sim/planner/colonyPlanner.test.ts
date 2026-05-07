import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { ColonyPlanner } from "./colonyPlanner";

describe("ColonyPlanner", () => {
  it("does not emit anything before its evaluation cadence elapses", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 30; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t });
    }
    expect(planner.blueprints.length).toBe(0);
  });

  it("emits a bedroom blueprint within an in-game hour", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t });
    }
    expect(planner.blueprints.length).toBe(1);
    const bp = planner.blueprints[0];
    expect(bp.kind).toBe("bedroom");
    expect(bp.cavity.length).toBe(bp.width * bp.height);
    // All cavity tiles must currently be solid.
    for (let i = 0; i < bp.cavity.length; i++) {
      const c = bp.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      expect(w.grid.isSolid(x, y)).toBe(true);
    }
  });

  it("never emits two overlapping blueprints", () => {
    const w = generateWorld({ seed: 23, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Gating signal allows ≥2 rooms once 2 in-game days (2880 ticks) have passed.
    // We hand-excavate cavities so the planner sees them complete and can emit
    // another (otherwise dwarves would do this in the live sim).
    for (let t = 1; t <= 5000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t });
      if (planner.blueprints.length > 0) {
        const bp = planner.blueprints[planner.blueprints.length - 1];
        if (bp.status === "digging") {
          for (let i = 0; i < bp.cavity.length; i++) {
            const c = bp.cavity[i];
            const x = c & 0xffff;
            const y = (c >>> 16) & 0xffff;
            // Use CorridorFloor (7) — walkable, non-solid.
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

  it("placement is deterministic across runs with the same seed", () => {
    const wa = generateWorld({ seed: 99, width: 200, height: 500 });
    const wb = generateWorld({ seed: 99, width: 200, height: 500 });
    const pa = new ColonyPlanner();
    const pb = new ColonyPlanner();
    for (let t = 1; t <= 200; t++) {
      pa.tick({ grid: wa.grid, spawn: wa.spawn, tick: t });
      pb.tick({ grid: wb.grid, spawn: wb.spawn, tick: t });
    }
    expect(pa.blueprints.length).toBe(pb.blueprints.length);
    for (let i = 0; i < pa.blueprints.length; i++) {
      expect(pa.blueprints[i].originX).toBe(pb.blueprints[i].originX);
      expect(pa.blueprints[i].originY).toBe(pb.blueprints[i].originY);
      expect(pa.blueprints[i].kind).toBe(pb.blueprints[i].kind);
    }
  });
});
