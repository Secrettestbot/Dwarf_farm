import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { ColonyPlanner } from "./colonyPlanner";

const POP_DEFAULT = 7;

describe("ColonyPlanner", () => {
  it("does not emit anything before its evaluation cadence elapses", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 30; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT });
    }
    expect(planner.blueprints.length).toBe(0);
  });

  it("emits at least one blueprint within an in-game hour", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT });
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

  it("emissions at population 1 are bedrooms only", () => {
    const w = generateWorld({ seed: 17, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    for (let t = 1; t <= 60; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1 });
    }
    expect(planner.blueprints.length).toBeGreaterThanOrEqual(1);
    for (const b of planner.blueprints) expect(b.kind).toBe("bedroom");
  });

  it("emits multiple blueprints as completed cavities free the gate (population 7)", () => {
    const w = generateWorld({ seed: 23, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Hand-excavate cavities so the planner sees them complete and can emit
    // another. With population 7 the target is ceil(7*1.5) = 11 rooms.
    for (let t = 1; t <= 800; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: POP_DEFAULT });
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

  it("stops emitting once the population target is met", () => {
    const w = generateWorld({ seed: 31, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Population 1: target = max(2, ceil(1*1.5)) = 2 rooms.
    for (let t = 1; t <= 4000; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 1 });
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
    expect(planner.completed).toBeLessThanOrEqual(2);
  });

  it("emits a dining hall once population reaches 4", () => {
    const w = generateWorld({ seed: 41, width: 200, height: 500 });
    const planner = new ColonyPlanner();
    // Hand-excavate as before so the planner can keep emitting.
    for (let t = 1; t <= 600; t++) {
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 4 });
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
      planner.tick({ grid: w.grid, spawn: w.spawn, tick: t, population: 5 });
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

  it("placement is deterministic across runs with the same seed", () => {
    const wa = generateWorld({ seed: 99, width: 200, height: 500 });
    const wb = generateWorld({ seed: 99, width: 200, height: 500 });
    const pa = new ColonyPlanner();
    const pb = new ColonyPlanner();
    for (let t = 1; t <= 200; t++) {
      pa.tick({ grid: wa.grid, spawn: wa.spawn, tick: t, population: POP_DEFAULT });
      pb.tick({ grid: wb.grid, spawn: wb.spawn, tick: t, population: POP_DEFAULT });
    }
    expect(pa.blueprints.length).toBe(pb.blueprints.length);
    for (let i = 0; i < pa.blueprints.length; i++) {
      expect(pa.blueprints[i].originX).toBe(pb.blueprints[i].originX);
      expect(pa.blueprints[i].originY).toBe(pb.blueprints[i].originY);
      expect(pa.blueprints[i].kind).toBe(pb.blueprints[i].kind);
    }
  });
});
