import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";

describe("diseases", () => {
  it("a sick dwarf with no medic and no rest can die from the disease", () => {
    const w = generateWorld({ seed: 401, width: 200, height: 500 });
    const sim = new SimWorld(401, w.grid, w.surfaceY, w.spawn);
    const id = sim.spawnDwarf({ name: "Patient", x: w.spawn.x, y: w.spawn.y, age: 30 });
    // Force a wound_sickness — fast HP drain (3/hour). Skip the
    // contraction roll by setting the component directly.
    sim.disease.set(id, { kind: "wound_sickness", contractedAtTick: 0, treatProgress: 0 });
    // Pin needs so the dwarf isn't running off to eat or sleep,
    // which would heal them faster than the disease drains.
    let died = false;
    for (let i = 0; i < 60 * 24 * 30 && !died; i++) {
      const n = sim.needs.get(id);
      if (n) { n.hunger = 100; n.thirst = 100; n.sleep = 100; n.social = 100; }
      // Keep them busy walking so they don't sleep / heal.
      const job = sim.job.get(id);
      if (job?.kind === "sleep") sim.job.remove(id);
      tick(sim);
      if (!sim.dwarf.get(id)) died = true;
    }
    expect(died).toBe(true);
    // Cause line lands in the chronicle with the disease label.
    const causeLine = sim.events.events.find((e) => e.text.includes("wound sickness"));
    expect(causeLine).toBeDefined();
  });

  it("a sick dwarf in a hospital cot with a skilled medic recovers", () => {
    const w = generateWorld({ seed: 403, width: 200, height: 500 });
    const sim = new SimWorld(403, w.grid, w.surfaceY, w.spawn);
    const sx = w.spawn.x;
    const sy = w.spawn.y;
    // Carve out a hospital cot tile right at spawn so the patient
    // is already on it.
    sim.grid.setTile(sx, sy, 42 /* HospitalBed */);
    // Plant a hospital blueprint so the cot is "officially" part of
    // a complete room (the diseaseSystem doesn't actually check
    // blueprint membership; the tile type is enough).
    sim.planner.blueprints.push({
      id: 9201,
      kind: "hospital",
      originX: sx,
      originY: sy,
      width: 1,
      height: 1,
      cavity: new Int32Array([(sy << 16) | sx]),
      status: "complete",
      priority: 1,
      createdTick: 0,
    });
    const patient = sim.spawnDwarf({ name: "Patient", x: sx, y: sy, age: 30 });
    sim.disease.set(patient, { kind: "cave_cough", contractedAtTick: 0, treatProgress: 0 });
    // Plant a Skilled medic in the colony.
    const medic = sim.spawnDwarf({ name: "Medic", x: sx + 1, y: sy, age: 35 });
    sim.dwarf.get(medic)!.skills.medicine = 12;
    let recovered = false;
    for (let i = 0; i < 60 * 24 * 30 && !recovered; i++) {
      const pn = sim.needs.get(patient);
      if (pn) { pn.hunger = 100; pn.thirst = 100; pn.sleep = 100; pn.social = 100; }
      const mn = sim.needs.get(medic);
      if (mn) { mn.hunger = 100; mn.thirst = 100; mn.sleep = 100; mn.social = 100; }
      // Force the patient on the cot in a sleep job EVERY tick — the
      // test's job is to confirm the disease cure flow, not to test
      // chooseTask routing.
      const ppos = sim.position.get(patient);
      if (ppos) { ppos.x = sx; ppos.y = sy; }
      sim.job.set(patient, { kind: "sleep", targetX: sx, targetY: sy, progress: 0 });
      tick(sim);
      if (!sim.disease.has(patient)) recovered = true;
    }
    expect(recovered).toBe(true);
    expect(sim.dwarf.get(patient)).toBeDefined();
  });
});
