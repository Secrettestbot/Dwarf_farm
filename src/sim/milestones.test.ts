import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { Blueprint } from "./planner/blueprint";

function plantSmelter(sim: SimWorld, ox: number, oy: number): Blueprint {
  const cavity: number[] = [];
  for (let yy = oy; yy < oy + 3; yy++) {
    for (let xx = ox; xx < ox + 3; xx++) {
      sim.grid.setTile(xx, yy, TileType.CorridorFloor);
      cavity.push((yy << 16) | xx);
    }
  }
  sim.grid.setTile(ox + 1, oy + 1, TileType.SmelterStation);
  const bp: Blueprint = {
    id: 9400,
    kind: "smelter",
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

describe("narrative milestones (GDD §10.2)", () => {
  it("Iron Mountain fires when the first bar comes off the smelter", () => {
    const w = generateWorld({ seed: 801, width: 200, height: 500 });
    const sim = new SimWorld(801, w.grid, w.surfaceY, w.spawn);
    for (let xx = w.spawn.x; xx <= w.spawn.x + 4; xx++) {
      sim.grid.setTile(xx, w.spawn.y, TileType.CorridorFloor);
    }
    plantSmelter(sim, w.spawn.x + 2, w.spawn.y - 1);
    sim.spawnDwarf({ name: "Smith", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.stockpile.ore = 5;
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 600; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
    }
    expect(sim.narrativeMilestones.has("iron_mountain")).toBe(true);
    const evt = sim.events.events.find((e) => e.text.startsWith("Iron Mountain"));
    expect(evt).toBeDefined();
  });

  it("The First Diamond fires the first time a diamond is mined", () => {
    const w = generateWorld({ seed: 803, width: 200, height: 500 });
    const sim = new SimWorld(803, w.grid, w.surfaceY, w.spawn);
    sim.grid.setTile(w.spawn.x + 1, w.spawn.y, TileType.RawDiamond);
    sim.planner.blueprints.push({
      id: 9401,
      kind: "mine",
      originX: w.spawn.x + 1,
      originY: w.spawn.y,
      width: 1,
      height: 1,
      cavity: new Int32Array([(w.spawn.y << 16) | (w.spawn.x + 1)]),
      status: "digging",
      priority: 1,
      createdTick: 0,
    });
    sim.sliders.hauling = 0;
    sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 200; i++) {
      const n = sim.needs.get(e)!;
      n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
      tick(sim);
      if (sim.narrativeMilestones.has("the_first_diamond")) break;
    }
    expect(sim.narrativeMilestones.has("the_first_diamond")).toBe(true);
  });

  it("The Gem Seam fires when a dwarf reaches depth 700", () => {
    const w = generateWorld({ seed: 805, width: 200, height: 1500 });
    const sim = new SimWorld(805, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Deep", x: w.spawn.x, y: w.spawn.y + 800, age: 30 });
    tick(sim);
    expect(sim.narrativeMilestones.has("the_gem_seam")).toBe(true);
  });

  it("Voice in the Stone fires alongside the Hollow King's awakening", () => {
    const w = generateWorld({ seed: 807, width: 200, height: 2000 });
    const sim = new SimWorld(807, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Voidwalker", x: w.spawn.x, y: w.spawn.y + 1700, age: 30 });
    tick(sim);
    expect(sim.narrativeMilestones.has("voice_in_the_stone")).toBe(true);
  });

  it("each milestone fires only once even if the trigger repeats", () => {
    const w = generateWorld({ seed: 809, width: 200, height: 1500 });
    const sim = new SimWorld(809, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Deep", x: w.spawn.x, y: w.spawn.y + 800, age: 30 });
    for (let i = 0; i < 50; i++) tick(sim);
    const matches = sim.events.events.filter((e) => e.text.startsWith("The Gem Seam"));
    expect(matches.length).toBe(1);
  });
});
