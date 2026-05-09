import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint, QUALITY_BASE } from "./planner/blueprint";

function plantBedroom(sim: SimWorld, ox: number, oy: number, w: number, h: number): Blueprint {
  const cavity = new Int32Array(w * h);
  let i = 0;
  for (let yy = oy; yy < oy + h; yy++) {
    for (let xx = ox; xx < ox + w; xx++) {
      cavity[i++] = (yy << 16) | xx;
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
    }
  }
  const bp: Blueprint = {
    id: 9900,
    kind: "bedroom",
    originX: ox,
    originY: oy,
    width: w,
    height: h,
    cavity,
    status: "complete",
    priority: 1,
    createdTick: 0,
    quality: QUALITY_BASE,
    lastMaintainedTick: 0,
  };
  sim.planner.blueprints.push(bp);
  return bp;
}

describe("engravings (GDD §7.2 / §6.3 Artistry)", () => {
  it("a Skilled artist standing in a finished room slowly raises its quality", () => {
    const w = generateWorld({ seed: 1101, width: 200, height: 500 });
    const sim = new SimWorld(1101, w.grid, w.surfaceY, w.spawn);
    const bp = plantBedroom(sim, w.spawn.x, w.spawn.y, 3, 2);
    const before = bp.quality ?? QUALITY_BASE;
    const id = sim.spawnDwarf({ name: "Carver", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.artistry = 12; // Skilled
    // Pin the dwarf in place (no needs decay) and avoid them
    // wandering off.
    for (let i = 0; i < 600; i++) {
      const n = sim.needs.get(id)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      // Pin the position so they don't wander out of the room.
      const p = sim.position.get(id)!;
      p.x = w.spawn.x + 1;
      p.y = w.spawn.y;
      tick(sim);
    }
    expect(bp.quality ?? 0).toBeGreaterThan(before);
  });

  it("a Novice artist contributes nothing — engraving needs Skilled+", () => {
    const w = generateWorld({ seed: 1103, width: 200, height: 500 });
    const sim = new SimWorld(1103, w.grid, w.surfaceY, w.spawn);
    const bp = plantBedroom(sim, w.spawn.x, w.spawn.y, 3, 2);
    const before = bp.quality ?? QUALITY_BASE;
    const id = sim.spawnDwarf({ name: "Beginner", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.dwarf.get(id)!.skills.artistry = 1;
    for (let i = 0; i < 600; i++) {
      const n = sim.needs.get(id)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      const p = sim.position.get(id)!;
      p.x = w.spawn.x + 1;
      p.y = w.spawn.y;
      tick(sim);
    }
    expect(bp.quality ?? 0).toBe(before);
  });
});
