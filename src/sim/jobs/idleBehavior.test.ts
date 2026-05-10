import { describe, it, expect } from "vitest";
import { generateWorld } from "../world/worldgen";
import { SimWorld } from "../world/simWorld";
import { tick } from "../sim";

function buildSim(seed: number, dwarfCount: number): SimWorld {
  const w = generateWorld({ seed, width: 200, height: 500 });
  const sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
  for (let i = 0; i < dwarfCount; i++) {
    sim.spawnDwarf({
      name: `Dwarf${i}`,
      x: w.spawn.x + (i % 3),
      y: w.spawn.y,
    });
  }
  return sim;
}

describe("idle behaviors", () => {
  it("dwarves do something every tick — never permanently idle", () => {
    // After mining the initial blueprints, dwarves with no work should
    // wander, sleep, or socialise rather than stand still forever.
    const sim = buildSim(11, 7);
    for (let i = 0; i < 1500; i++) tick(sim);
    // Look at the last 100 ticks: most ticks each dwarf should have some job.
    let idleObservations = 0;
    let totalObservations = 0;
    for (let t = 0; t < 100; t++) {
      tick(sim);
      sim.forEachDwarf((id) => {
        totalObservations++;
        if (!sim.job.has(id)) idleObservations++;
      });
    }
    // Less than half of all dwarf-ticks should be idle (most should be
    // doing something). The transient between jobs is a tick or two.
    expect(idleObservations).toBeLessThan(totalObservations * 0.5);
  });

  it("sleep need restores when a dwarf sleeps", () => {
    const sim = buildSim(13, 1);
    const e = sim.dwarf.entities[0];
    // Force critical sleep so the dwarf elects to rest.
    const needs = sim.needs.get(e)!;
    needs.sleep = 10;
    // Long enough to walk + sleep.
    for (let i = 0; i < 600; i++) tick(sim);
    expect(needs.sleep).toBeGreaterThan(40);
  });

  it("dwarves disperse to different mining targets via claim-locking", () => {
    const sim = buildSim(19, 7);
    // Run long enough for the planner to emit blueprints and dwarves to
    // claim mining targets.
    for (let i = 0; i < 90; i++) tick(sim);
    // Collect target tiles for any dwarves with active mine jobs.
    const targets = new Set<number>();
    let mineCount = 0;
    sim.forEachDwarf((id) => {
      const job = sim.job.get(id);
      if (job?.kind === "mine") {
        mineCount++;
        targets.add((job.targetY << 16) | job.targetX);
      }
    });
    // If multiple dwarves are mining, they must each have a different target.
    if (mineCount >= 2) {
      expect(targets.size).toBe(mineCount);
    }
  });

  it("two idle dwarves with low social need pair up to socialise", () => {
    const sim = buildSim(17, 2);
    // Force both into low social.
    for (const e of sim.dwarf.entities) {
      const n = sim.needs.get(e)!;
      n.social = 10;
      n.sleep = 100; // healthy so social wins priority
    }
    let socialiseObserved = false;
    for (let i = 0; i < 400; i++) {
      tick(sim);
      for (const e of sim.dwarf.entities) {
        const j = sim.job.get(e);
        if (j?.kind === "socialise") {
          socialiseObserved = true;
          break;
        }
      }
      if (socialiseObserved) break;
    }
    expect(socialiseObserved).toBe(true);
  });

  it("a starved-of-social dwarf in a busy colony actually gets to chat", () => {
    // Regression for "social never goes up": in any non-trivial colony
    // every dwarf always has a mining / hauling / crafting job, so the
    // priority-8 socialise branch never fires. The fix is the
    // critical-social branch (priority 3.5) plus a lenient partner
    // search that accepts working dwarves as chat targets.
    const sim = buildSim(23, 5);
    // Run a while so the planner emits work and dwarves dispatch into it.
    for (let i = 0; i < 200; i++) tick(sim);
    const subject = sim.dwarf.entities[0];
    const startSocial = 5;
    const subjectNeeds = sim.needs.get(subject)!;
    subjectNeeds.social = startSocial;
    // Pin the subject's other needs high so social is the only one in the red.
    subjectNeeds.hunger = 100;
    subjectNeeds.thirst = 100;
    subjectNeeds.sleep = 100;
    // Run forward; the subject should land a socialise job and their
    // social need should rise above where it started.
    let socialiseObserved = false;
    for (let i = 0; i < 600; i++) {
      tick(sim);
      // Keep the survival needs pinned high so other interrupts don't fire.
      subjectNeeds.hunger = 100;
      subjectNeeds.thirst = 100;
      subjectNeeds.sleep = 100;
      const j = sim.job.get(subject);
      if (j?.kind === "socialise") socialiseObserved = true;
    }
    expect(socialiseObserved).toBe(true);
    expect(subjectNeeds.social).toBeGreaterThan(startSocial);
  });
});
