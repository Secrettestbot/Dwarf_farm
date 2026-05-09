import { describe, it, expect } from "vitest";
import { effectsFor } from "./dwarves/traitEffects";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

describe("more wired traits (GDD §6.5)", () => {
  it("Strong and Slight scale workSpeed in opposite directions", () => {
    expect(effectsFor(["strong"]).workSpeed).toBeCloseTo(1.10);
    expect(effectsFor(["slight"]).workSpeed).toBeCloseTo(0.85);
  });

  it("Loyal/Fickle change the bereavement morale scale", () => {
    expect(effectsFor(["loyal"]).bereavementScale).toBe(2);
    expect(effectsFor(["fickle"]).bereavementScale).toBe(0.25);
  });

  it("Eagle-Eyed gets a wider visibility radius", () => {
    expect(effectsFor(["eagle_eyed"]).visibilityRadius).toBe(8);
    expect(effectsFor([]).visibilityRadius).toBe(5);
  });

  it("a Loyal partner takes a real morale hit when their bond dies", () => {
    const w = generateWorld({ seed: 1201, width: 200, height: 500 });
    const sim = new SimWorld(1201, w.grid, w.surfaceY, w.spawn);
    const a = sim.spawnDwarf({ name: "A", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["loyal"] });
    const b = sim.spawnDwarf({ name: "B", x: w.spawn.x + 1, y: w.spawn.y, age: 30 });
    sim.dwarf.get(a)!.partnerId = b;
    sim.dwarf.get(b)!.partnerId = a;
    const aNeeds = sim.needs.get(a)!;
    aNeeds.morale = 80;
    // Force B to starve (kills via needsSystem with a non-violent
    // cause — bereavement still fires).
    const bNeeds = sim.needs.get(b)!;
    bNeeds.thirst = 0;
    tick(sim);
    // Loyal: hit = 15 * 2 = 30. Morale should drop ~30 from 80.
    expect(sim.needs.get(a)!.morale).toBeLessThanOrEqual(60);
  });

  it("an Eagle-Eyed dwarf reveals a wider radius than a default one", () => {
    const w = generateWorld({ seed: 1203, width: 200, height: 500 });
    const sim = new SimWorld(1203, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf({ name: "Scout", x: w.spawn.x, y: w.spawn.y, age: 30, traitIds: ["eagle_eyed"] });
    tick(sim);
    // The default radius is 5; Eagle-Eyed sees out to 8. So a tile
    // 7 away should be marked seen for the Eagle-Eyed dwarf only.
    expect(sim.grid.isSeen(w.spawn.x + 7, w.spawn.y)).toBe(true);
  });
});
