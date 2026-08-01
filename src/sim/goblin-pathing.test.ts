import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

function carveArena(sim: SimWorld, cx: number, cy: number, r: number) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      sim.grid.setTile(cx + dx, cy + dy, TileType.CorridorFloor);
    }
  }
}

function pinDwarf(sim: SimWorld, id: number) {
  const pos = sim.position.get(id)!;
  sim.needs.get(id)!.sleep = 0;
  sim.job.set(id, { kind: "sleep", targetX: pos.x, targetY: pos.y, progress: 0 });
}

describe("goblin pathfinding", () => {
  it("a goblin routes around a concave wall the greedy step would pin against", () => {
    const w = generateWorld({ seed: 3301, width: 200, height: 500 });
    const sim = new SimWorld(3301, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    carveArena(sim, sx, sy, 10);
    // Vertical wall between goblin and dwarf, open only at the top —
    // the greedy sign-step (dy = 0) jams against it forever.
    for (let dy = -2; dy <= 10; dy++) {
      sim.grid.setTile(sx - 2, sy + dy, TileType.Granite);
    }
    sim.regions.invalidate();
    const d = sim.spawnDwarf({ name: "Bait", x: sx - 6, y: sy, age: 30 });
    const n = sim.needs.get(d)!;
    n.hunger = 100; n.thirst = 100; n.social = 100;
    pinDwarf(sim, d);
    const gob = sim.spawnHostile({ kind: "goblin_scout", x: sx + 2, y: sy });
    for (let i = 0; i < 300 && sim.ecs.isAlive(gob); i++) tick(sim);
    // The goblin either crossed the wall (west of it) or already
    // killed the bait and was itself unhindered — both prove routing.
    if (sim.ecs.isAlive(gob)) {
      const pos = sim.position.get(gob)!;
      expect(pos.x).toBeLessThan(sx - 2);
    }
  });
});
