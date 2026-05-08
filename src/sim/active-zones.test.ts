import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

describe("active-zones gate (GDD §12.3)", () => {
  it("a hostile far from any dwarf stays where it spawned", () => {
    const w = generateWorld({ seed: 701, width: 200, height: 500 });
    const sim = new SimWorld(701, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Drop a hostile far past the active radius (100). Carve a strip of
    // floor under it so it could walk if it were active.
    const farX = w.spawn.x + 150;
    const farY = w.spawn.y;
    for (let xx = farX - 5; xx <= farX + 5; xx++) {
      sim.grid.setTile(xx, farY, 7); // CorridorFloor
    }
    sim.spawnHostile({ kind: "cave_rat", x: farX, y: farY });
    const startX = farX;
    const startY = farY;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    const hEnt = sim.hostile.entities[0];
    const hPos = sim.position.get(hEnt)!;
    expect(hPos.x).toBe(startX);
    expect(hPos.y).toBe(startY);
  });

  it("a hostile within active radius does take its turn", () => {
    const w = generateWorld({ seed: 703, width: 200, height: 500 });
    const sim = new SimWorld(703, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "D", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Place the hostile inside the active radius (within 100 tiles)
    // but outside its own pursueRange (cave_rat = 12) so it actively
    // *would* try to move closer.
    const hx = w.spawn.x + 5;
    const hy = w.spawn.y;
    for (let xx = w.spawn.x - 1; xx <= w.spawn.x + 10; xx++) {
      sim.grid.setTile(xx, hy, 7);
    }
    sim.spawnHostile({ kind: "cave_rat", x: hx, y: hy });
    const startX = hx;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 100; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    const hEnt = sim.hostile.entities[0];
    const hPos = sim.position.get(hEnt);
    // The rat should have moved toward the dwarf (or already reached
    // and engaged combat — either way, x decreased from start).
    expect(hPos === undefined || hPos.x < startX).toBe(true);
  });
});
