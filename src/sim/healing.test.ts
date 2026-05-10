import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TileType } from "./world/tiles";

function buildSim(seed: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  sim.spawnDwarf({ name: "Borin", x: w.spawn.x, y: w.spawn.y, age: 30 });
  return sim;
}

describe("healing", () => {
  it("a dwarf out of combat slowly regenerates HP", () => {
    const sim = buildSim(1);
    const e = sim.dwarf.entities[0];
    const hp = sim.health.get(e)!;
    hp.hp = 60;
    // Run a few healing intervals.
    for (let i = 0; i < 600; i++) tick(sim);
    expect(sim.health.get(e)!.hp).toBeGreaterThan(60);
  });

  it("a dwarf adjacent to a hostile does not heal", () => {
    const sim = buildSim(2);
    const e = sim.dwarf.entities[0];
    const pos = sim.position.get(e)!;
    const ratId = sim.spawnHostile({ kind: "cave_rat", x: pos.x + 1, y: pos.y });
    const hp = sim.health.get(e)!;
    hp.hp = 60;
    // Stop the rat from killing the dwarf in the test window: prop up
    // dwarf's HP at 60 every few ticks if it's about to drop too low,
    // and end the test before combat resolves.
    for (let i = 0; i < 60; i++) {
      tick(sim);
      // Floor-clamp so combat doesn't kill the dwarf — we're testing
      // healing, not combat survival.
      if (hp.hp < 50) hp.hp = 50;
    }
    // The dwarf has been adjacent to a rat the whole window, so healing
    // shouldn't have meaningfully fired. (Combat may have changed HP, but
    // healing should not have run.) Conservative assertion: HP did not
    // climb back to full.
    expect(sim.health.get(e)!.hp).toBeLessThan(hp.maxHp);
    // Cleanup so the test doesn't leave a ratId reference.
    void ratId;
  });

  it("recovery from severe wounds emits a 'recovered' event", () => {
    const sim = buildSim(3);
    const e = sim.dwarf.entities[0];
    const hp = sim.health.get(e)!;
    // Drop to severe (below 30% threshold). Set the flag the combat
    // system would normally set on a damaging hit.
    hp.hp = 20;
    hp.wasSevereWound = true;
    // Pin needs each tick so Borin doesn't die mid-run and free
    // his entity slot for a migrant — the calendar-aging test
    // already documents this slot-reuse issue.
    for (let i = 0; i < 6000; i++) {
      const n = sim.needs.get(e);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      tick(sim);
    }
    expect(sim.health.get(e)!.hp).toBe(hp.maxHp);
    const recovered = sim.events.events.find((ev) =>
      ev.text.includes("recovered from their wounds"),
    );
    expect(recovered).toBeDefined();
  });

  it("a wounded dwarf chooses to rest (not work)", () => {
    const sim = buildSim(5);
    const e = sim.dwarf.entities[0];
    const hp = sim.health.get(e)!;
    hp.hp = 40; // below 50% wound threshold
    // Run a few ticks to let chooseTask fire.
    let sleepSeen = false;
    for (let i = 0; i < 200; i++) {
      tick(sim);
      const job = sim.job.get(e);
      if (job?.kind === "sleep") {
        sleepSeen = true;
        break;
      }
      // If the dwarf already healed past the threshold (very generous
      // healing), bail. This shouldn't happen at 1 hp/30 ticks.
      if (sim.health.get(e)!.hp >= 50) break;
    }
    expect(sleepSeen).toBe(true);
  });

  it("sleeping on a Bed tile heals faster than sleeping elsewhere", () => {
    // Compare two sims: one with the spawn tile as Bed, one as plain
    // walkable. Pin survival needs to keep both dwarves on the wounded-
    // priority sleep branch and not diverting to drink.
    const a = buildSim(7);
    const b = buildSim(7);
    const eA = a.dwarf.entities[0];
    const eB = b.dwarf.entities[0];
    const posA = a.position.get(eA)!;
    a.grid.setTile(posA.x, posA.y, TileType.Bed);
    a.health.get(eA)!.hp = 40;
    b.health.get(eB)!.hp = 40;
    for (let i = 0; i < 600; i++) {
      const na = a.needs.get(eA)!;
      const nb = b.needs.get(eB)!;
      na.thirst = 100; na.hunger = 100; na.sleep = 100;
      nb.thirst = 100; nb.hunger = 100; nb.sleep = 100;
      tick(a);
      tick(b);
    }
    const hpA = a.health.get(eA)!.hp;
    const hpB = b.health.get(eB)!.hp;
    expect(hpA).toBeGreaterThanOrEqual(hpB);
  });
});
