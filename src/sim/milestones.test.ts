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

  it("The Silver Halls fires the first time a silver vein is mined", () => {
    const w = generateWorld({ seed: 811, width: 200, height: 500 });
    const sim = new SimWorld(811, w.grid, w.surfaceY, w.spawn);
    // Plant a silver tile inside an active mine blueprint at spawn.
    sim.grid.setTile(w.spawn.x + 1, w.spawn.y, 30 /* TileType.Silver */);
    sim.planner.blueprints.push({
      id: 9402,
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
      if (sim.narrativeMilestones.has("the_silver_halls")) break;
    }
    expect(sim.narrativeMilestones.has("the_silver_halls")).toBe(true);
  });

  it("Three Generations fires when both parents were themselves born in-colony", () => {
    const w = generateWorld({ seed: 817, width: 200, height: 500 });
    const sim = new SimWorld(817, w.grid, w.surfaceY, w.spawn);
    // Hand-spawn two adults flagged as in-colony births. Pair them, run
    // a year, expect a child + the milestone.
    const m = sim.spawnDwarf({ name: "Mother", x: w.spawn.x, y: w.spawn.y, age: 25, bornInColony: true });
    const f = sim.spawnDwarf({ name: "Father", x: w.spawn.x + 1, y: w.spawn.y, age: 27, bornInColony: true });
    sim.dwarf.get(m)!.partnerId = f;
    sim.dwarf.get(f)!.partnerId = m;
    let fired = false;
    for (let y = 1; y <= 12 && !fired; y++) {
      for (let i = 0; i < 24 * 60 * 24; i++) {
        for (const id of sim.dwarf.entities) {
          const n = sim.needs.get(id);
          if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
        }
        tick(sim);
      }
      if (sim.narrativeMilestones.has("three_generations")) fired = true;
    }
    expect(fired).toBe(true);
  });

  it("The Aquifer Survived fires after living a week past a breach", () => {
    const w = generateWorld({ seed: 831, width: 200, height: 500 });
    const sim = new SimWorld(831, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Survivor", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Hand-trigger the breach: place water at a known tile and stamp
    // the breach clock. Saves a thousand ticks of digging through a
    // procedurally-placed aquifer.
    sim.grid.setTile(w.spawn.x + 1, w.spawn.y, TileType.Water);
    sim.aquiferBreachTick = sim.tick;
    const e = sim.dwarf.entities[0];
    // Run more than a week of in-game time. Pin needs so the dwarf
    // doesn't die — the milestone requires at least one survivor.
    for (let i = 0; i < 24 * 60 * 8; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
      if (sim.narrativeMilestones.has("the_aquifer_survived")) break;
    }
    expect(sim.narrativeMilestones.has("the_aquifer_survived")).toBe(true);
  });

  it("The Aquifer Survived does not fire if no breach has happened", () => {
    const w = generateWorld({ seed: 833, width: 200, height: 500 });
    const sim = new SimWorld(833, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Untouched", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const e = sim.dwarf.entities[0];
    for (let i = 0; i < 24 * 60 * 8; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.narrativeMilestones.has("the_aquifer_survived")).toBe(false);
  });

  it("The Grand Citadel fires once a throne room is complete", () => {
    const w = generateWorld({ seed: 821, width: 200, height: 500 });
    const sim = new SimWorld(821, w.grid, w.surfaceY, w.spawn);
    // Plant a synthetic completed throne room. The blueprint kind +
    // status flip is what the milestone watcher looks for.
    const cavity: number[] = [];
    for (let yy = w.spawn.y; yy < w.spawn.y + 4; yy++) {
      for (let xx = w.spawn.x + 1; xx < w.spawn.x + 6; xx++) {
        cavity.push((yy << 16) | xx);
      }
    }
    sim.planner.blueprints.push({
      id: 9500,
      kind: "throne_room",
      originX: w.spawn.x + 1,
      originY: w.spawn.y,
      width: 5,
      height: 4,
      cavity: new Int32Array(cavity),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    tick(sim);
    expect(sim.narrativeMilestones.has("the_grand_citadel")).toBe(true);
  });

  it("The Siege Endured fires after enough void shades are slain", () => {
    const w = generateWorld({ seed: 823, width: 200, height: 2000 });
    const sim = new SimWorld(823, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Slayer", x: w.spawn.x, y: w.spawn.y, age: 30 });
    sim.dwarf.get(sim.dwarf.entities[0])!.skills.military = 18;
    sim.squad.set(sim.dwarf.entities[0], { draftedAtTick: 0 });
    sim.equipment.set(sim.dwarf.entities[0], { weapon: true });
    for (let n = 0; n < 25; n++) {
      sim.spawnHostile({ kind: "void_shade", x: w.spawn.x + 1, y: w.spawn.y });
      sim.health.set(sim.hostile.entities[sim.hostile.entities.length - 1], {
        hp: 1, maxHp: 90, lastAttackTick: -1000,
      });
      const eid = sim.dwarf.entities[0];
      const hp = sim.health.get(eid)!;
      hp.hp = hp.maxHp;
      hp.lastAttackTick = -1000;
      const need = sim.needs.get(eid)!;
      need.hunger = 100; need.thirst = 100; need.sleep = 100; need.social = 100;
      tick(sim);
      if (sim.narrativeMilestones.has("the_siege_endured")) break;
    }
    expect(sim.narrativeMilestones.has("the_siege_endured")).toBe(true);
    // The King-Falls milestone must NOT fire just from killing shades.
    expect(sim.narrativeMilestones.has("the_hollow_king_falls")).toBe(false);
  });

  it("The Hollow King Falls fires only when the King himself is killed", () => {
    const w = generateWorld({ seed: 825, width: 200, height: 2000 });
    const sim = new SimWorld(825, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Champion", x: w.spawn.x, y: w.spawn.y, age: 30 });
    const eid = sim.dwarf.entities[0];
    sim.dwarf.get(eid)!.skills.military = 18;
    sim.squad.set(eid, { draftedAtTick: 0 });
    sim.equipment.set(eid, { weapon: true });
    // Manifest the King by hand right next to the champion. (The
    // research-gated spawn path is exercised separately below.)
    sim.spawnHostile({ kind: "hollow_king", x: w.spawn.x + 1, y: w.spawn.y });
    const kingEnt = sim.hostile.entities[sim.hostile.entities.length - 1];
    sim.health.set(kingEnt, { hp: 1, maxHp: 800, lastAttackTick: -1000 });
    sim.hollowKingSpawned = true;
    // Pin the dwarf so the King's blow doesn't kill them on the
    // counter-strike.
    const hp = sim.health.get(eid)!;
    hp.hp = 10000; hp.maxHp = 10000; hp.lastAttackTick = -1000;
    const need = sim.needs.get(eid)!;
    need.hunger = 100; need.thirst = 100; need.sleep = 100; need.social = 100;
    for (let i = 0; i < 200; i++) {
      tick(sim);
      if (sim.narrativeMilestones.has("the_hollow_king_falls")) break;
      hp.hp = hp.maxHp;
    }
    expect(sim.narrativeMilestones.has("the_hollow_king_falls")).toBe(true);
  });

  it("The Hollow King manifests once The King's Name is researched", () => {
    const w = generateWorld({ seed: 827, width: 200, height: 2000 });
    const sim = new SimWorld(827, w.grid, w.surfaceY, w.spawn);
    // Carve a reachable strip into the Underworld so the spawn site
    // search succeeds. The reachable mask reads from the planner; we
    // hand-set a connected corridor instead of a real dig.
    for (let y = sim.spawn.y; y <= sim.spawn.y + 1700; y++) {
      sim.grid.setTile(sim.spawn.x, y, 7 /* CorridorFloor */);
    }
    // Spawn a dwarf in the Underworld so hollowKingAware flips, and
    // mark the research complete.
    sim.spawnDwarf({ name: "Voidwalker", x: sim.spawn.x, y: sim.spawn.y + 1700, age: 30 });
    sim.research.completed.push("the_kings_name");
    // Run a few ticks: the awakening + manifest run on consecutive
    // ticks of the same hollowKingSystem-driven flow.
    for (let i = 0; i < 5; i++) tick(sim);
    expect(sim.hollowKingSpawned).toBe(true);
    let kingPresent = false;
    for (const ent of sim.hostile.entities) {
      if (sim.hostile.get(ent)?.kind === "hollow_king") kingPresent = true;
    }
    expect(kingPresent).toBe(true);
  });

  it("Legends of the Deep fires when every drafted soldier has a Legendary skill", () => {
    const w = generateWorld({ seed: 815, width: 200, height: 500 });
    const sim = new SimWorld(815, w.grid, w.surfaceY, w.spawn);
    // Spawn 30 adults all with Legendary Military so any year-end
    // draft (whatever the cap rolls to after migration mid-year) picks
    // a fully-legendary squad. Migrants brought in by migration
    // arrive with rolled skills and could dilute the squad — to keep
    // the test deterministic we lock the migration slider off. (The
    // emergency lockdown blocks immigrants per its own rules.)
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    for (let i = 0; i < 30; i++) {
      const id = sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x, y: w.spawn.y, age: 30 });
      sim.dwarf.get(id)!.skills.military = 18;
    }
    // Run a year so the draft fires.
    for (let i = 0; i < 24 * 60 * 24 + 5; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    expect(sim.narrativeMilestones.has("legends_of_the_deep")).toBe(true);
  });
});
