import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";
import { TICKS_PER_DAY, TICKS_PER_YEAR } from "./time";
import { siegeHuntStep, SEAL_HP, FORTIFIED_SEAL_HP } from "./systems/siegeHunt";

function makeSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  return new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
}

function pin(sim: SimWorld): void {
  for (const e of sim.dwarf.entities) {
    const n = sim.needs.get(e)!;
    n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100;
  }
}

/** A long straight tunnel with a dwarf at the far end. */
function tunnel(sim: SimWorld, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) sim.grid.setTile(x, y, TileType.CorridorFloor);
  sim.regions.invalidate();
}

describe("siege warbands", () => {
  it("no siege comes before the end of the colony's second year", () => {
    const sim = makeSim(901);
    for (let i = 0; i < 12; i++) sim.spawnDwarf({ name: `D${i}`, x: sim.spawn.x, y: sim.spawn.y, age: 30 });
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      pin(sim);
      tick(sim);
    }
    expect(sim.siegeScheduledTick).toBe(-1);
    expect(sim.siegeActive).toBe(false);
  });

  it("a siege goblin with nobody in range still advances on the colony", () => {
    const sim = makeSim(903);
    const y = 300;
    tunnel(sim, y, 20, 120);
    sim.spawnDwarf({ name: "Hiding", x: 120, y, age: 30 });
    const pos = { x: 20, y };
    // 100 tiles away: far beyond a goblin's pursue range.
    for (let i = 0; i < 10; i++) expect(siegeHuntStep(sim, pos)).toBe(true);
    expect(pos.x).toBe(30);
  });

  it("a warband batters a Lockdown seal open, and fortification makes it hold longer", () => {
    const blowsToBreak = (fortified: boolean) => {
      const sim = makeSim(905);
      const y = 300;
      tunnel(sim, y, 20, 40);
      sim.spawnDwarf({ name: "Inside", x: 40, y, age: 30 });
      // Seal one tile in the tunnel as Lockdown would.
      sim.emergency.sealed = [30, y, TileType.CorridorFloor];
      sim.emergency.sealDamage = [];
      sim.grid.setTile(30, y, TileType.DoorBarred);
      sim.regions.invalidate();
      if (fortified) sim.research.completed.push("fortification_design");
      const pos = { x: 29, y };
      let blows = 0;
      while (sim.grid.getTile(30, y) === TileType.DoorBarred && blows < 10_000) {
        siegeHuntStep(sim, pos);
        blows++;
        sim.tick++;
      }
      expect(pos.x).toBe(29); // battered in place, never walked through
      expect(sim.grid.getTile(30, y)).toBe(TileType.CorridorFloor);
      expect(sim.emergency.sealed).toEqual([]);
      expect(sim.events.events.some((e) => /battered through a sealed entrance/.test(e.text))).toBe(true);
      return blows;
    };
    expect(blowsToBreak(false)).toBe(SEAL_HP);
    expect(blowsToBreak(true)).toBe(FORTIFIED_SEAL_HP);
  });
});
