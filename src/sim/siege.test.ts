import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { TICKS_PER_YEAR, TICKS_PER_DAY } from "./time";

describe("siege system", () => {
  it("fires an outrider warning ~5 days before the warband arrives", () => {
    const w = generateWorld({ seed: 711, width: 200, height: 500 });
    const sim = new SimWorld(711, w.grid, w.surfaceY, w.spawn);
    // Spawn enough founders for the SIEGE_MIN_POPULATION gate.
    for (let i = 0; i < 12; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    // Year 1 + a week is enough to clear the schedule + lead + spawn.
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    // Find the warning and warband events anywhere in the log
    // (other events fire between them).
    const warning = sim.events.events.find((e) => e.text.includes("warband approaching"));
    const warband = sim.events.events.find((e) => e.text.includes("siege begins"));
    expect(warning).toBeDefined();
    expect(warband).toBeDefined();
    expect(warband!.tick).toBeGreaterThan(warning!.tick);
    // Should be at least 4 days between warning and warband (lead is 5).
    expect(warband!.tick - warning!.tick).toBeGreaterThanOrEqual(TICKS_PER_DAY * 4);
  });

  it("a colony below SIEGE_MIN_POPULATION (10) is never sieged", () => {
    const w = generateWorld({ seed: 713, width: 200, height: 500 });
    const sim = new SimWorld(713, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 7; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + i - 3, y: w.spawn.y, age: 30 });
    }
    // Block migration so the population stays under the siege gate
    // for the duration of the run. The siege check fires at year
    // boundaries; without lockdown a seven-dwarf colony would have
    // grown past 10 by then.
    sim.emergency.mode = "lockdown";
    sim.emergency.startedAtTick = 0;
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
    }
    expect(sim.siegeActive).toBe(false);
    const sieged = sim.events.events.find((e) => e.text.includes("siege begins"));
    expect(sieged).toBeUndefined();
  });

  it("a siege at pop ≥ 15 includes a named warlord", () => {
    const w = generateWorld({ seed: 717, width: 200, height: 500 });
    const sim = new SimWorld(717, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 18; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
      if (sim.siegeActive) break;
    }
    expect(sim.siegeActive).toBe(true);
    expect(sim.siegeWarlordName).not.toBe("");
    // At least one goblin_warlord hostile should be on the map.
    let warlords = 0;
    for (const id of sim.hostile.entities) {
      const h = sim.hostile.get(id);
      if (h?.kind === "goblin_warlord") warlords++;
    }
    expect(warlords).toBe(1);
    // Warlord HP definition: 110 maxHp, bigger than a scout's 50.
    let warlordHp = -1;
    for (const id of sim.hostile.entities) {
      const h = sim.hostile.get(id);
      if (h?.kind === "goblin_warlord") {
        warlordHp = sim.health.get(id)?.maxHp ?? -1;
        break;
      }
    }
    expect(warlordHp).toBeGreaterThanOrEqual(100);
  });

  it("warlord name survives save/restore via the Hostile component (not via stale entity ids)", async () => {
    // Regression: the prior sim.hostileNames Map was keyed by
    // EntityId. Restore replayed spawnHostile with fresh ids, so
    // the saved (id, name) pairs pointed to nothing. After this
    // fix the name lives on the Hostile component itself, so the
    // restored warlord still knows its name.
    const { snapshot, restore } = await import("../save/snapshot");
    const w = generateWorld({ seed: 719, width: 200, height: 500 });
    const sim = new SimWorld(719, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 18; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
      if (sim.siegeActive) break;
    }
    expect(sim.siegeActive).toBe(true);
    let savedName: string | undefined;
    for (const id of sim.hostile.entities) {
      const h = sim.hostile.get(id);
      if (h?.kind === "goblin_warlord") savedName = h.name;
    }
    expect(savedName).toBeDefined();
    expect(savedName!.length).toBeGreaterThan(0);

    const save = snapshot({
      sim,
      slotId: "slot-1",
      fortressName: "fortress",
      mode: "legacy",
      cameraX: 0,
      cameraY: 0,
      zoomIndex: 1,
    });
    const restored = restore(save);
    let restoredName: string | undefined;
    for (const id of restored.hostile.entities) {
      const h = restored.hostile.get(id);
      if (h?.kind === "goblin_warlord") restoredName = h.name;
    }
    expect(restoredName).toBe(savedName);
  });

  it("legacy saves (hostileNames + no per-hostile fromSiege) restore with a named warlord AND a still-active siege", async () => {
    // Regression: when the warlord name moved from sim.hostileNames
    // to Hostile.name and the siege "broken" check moved from kind-
    // matching to Hostile.fromSiege, saves written by the previous
    // build became unrecoverable mid-siege: the warlord was anonymous
    // and the next tick declared the siege broken because no hostile
    // carried fromSiege=true. restore() now migrates these.
    const { snapshot, restore } = await import("../save/snapshot");
    const w = generateWorld({ seed: 723, width: 200, height: 500 });
    const sim = new SimWorld(723, w.grid, w.surfaceY, w.spawn);
    for (let i = 0; i < 18; i++) {
      sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
    }
    for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      }
      tick(sim);
      if (sim.siegeActive) break;
    }
    expect(sim.siegeActive).toBe(true);
    let warlordName: string | undefined;
    for (const id of sim.hostile.entities) {
      const h = sim.hostile.get(id);
      if (h?.kind === "goblin_warlord") warlordName = h.name;
    }
    expect(warlordName).toBeDefined();
    const save = snapshot({
      sim,
      slotId: "slot-1",
      fortressName: "fortress",
      mode: "legacy",
      cameraX: 0,
      cameraY: 0,
      zoomIndex: 1,
    });
    // Simulate a save written by the PREVIOUS build:
    //  - hostileNames populated keyed by (now-stale) entity ids
    //  - SavedHostile entries lack name + fromSiege
    save.hostileNames = warlordName ? [{ id: 999, name: warlordName }] : [];
    for (const h of save.hostiles ?? []) {
      delete h.name;
      delete h.fromSiege;
    }
    const restored = restore(save);
    expect(restored.siegeActive).toBe(true);
    let restoredWarlordName: string | undefined;
    for (const id of restored.hostile.entities) {
      const h = restored.hostile.get(id);
      if (h?.kind === "goblin_warlord") restoredWarlordName = h.name;
    }
    expect(restoredWarlordName).toBe(warlordName);
    // Run one tick — the migrated fromSiege flags should keep the
    // siege live (the pre-fix bug ended it on this tick).
    tick(restored);
    expect(restored.siegeActive).toBe(true);
  });

  it("warband size scales with population", () => {
    function countGoblinsAfterArrival(pop: number): number {
      const w = generateWorld({ seed: 715, width: 200, height: 500 });
      const sim = new SimWorld(715, w.grid, w.surfaceY, w.spawn);
      for (let i = 0; i < pop; i++) {
        sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 5) - 2, y: w.spawn.y, age: 30 });
      }
      for (let i = 0; i < TICKS_PER_YEAR + TICKS_PER_DAY * 7; i++) {
        for (const id of sim.dwarf.entities) {
          const n = sim.needs.get(id);
          if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
        }
        tick(sim);
        if (sim.siegeActive) break;
      }
      let goblins = 0;
      for (const id of sim.hostile.entities) {
        const h = sim.hostile.get(id);
        if (h?.kind === "goblin_scout") goblins++;
      }
      return goblins;
    }
    const small = countGoblinsAfterArrival(12);
    const large = countGoblinsAfterArrival(36);
    expect(large).toBeGreaterThan(small);
  });
});
