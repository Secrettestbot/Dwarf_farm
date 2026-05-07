import { SimWorld } from "../sim/world/simWorld";
import { generateWorld } from "../sim/world/worldgen";
import { CURRENT_SAVE_VERSION, SaveV1, SavedBlueprint, SavedDwarf, GameMode } from "./schema";
import { decodeOverrides, encodeOverrides } from "./codec";
import { Blueprint, BlueprintKind } from "../sim/planner/blueprint";

// Serialize / deserialize a SimWorld to/from a SaveV1. The save records only
// what's needed to deterministically reconstruct the simulation: seed, RLE
// delta vs a clean regen, RNG states, the dwarf list with traits/skills, and
// the colony planner state.

export interface SnapshotInput {
  sim: SimWorld;
  slotId: string;
  fortressName: string;
  mode: GameMode;
  cameraX: number;
  cameraY: number;
  zoomIndex: number;
}

export function snapshot(input: SnapshotInput): SaveV1 {
  const baseline = generateWorld({
    seed: input.sim.seed,
    width: input.sim.grid.width,
    height: input.sim.grid.height,
  });
  const overrides = encodeOverrides(input.sim.grid, baseline.grid);

  const dwarves: SavedDwarf[] = [];
  input.sim.forEachDwarf((_id, pos, dw) => {
    dwarves.push({
      name: dw.name,
      x: pos.x,
      y: pos.y,
      traitIds: dw.traitIds,
      skills: dw.skills,
      profession: dw.profession,
      age: dw.age,
      lastJobTick: dw.lastJobTick,
    });
  });

  const planner = input.sim.planner;
  const blueprints: SavedBlueprint[] = planner.blueprints.map((b) => {
    const cells: number[] = new Array(b.cavity.length * 2);
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      cells[i * 2] = c & 0xffff;
      cells[i * 2 + 1] = (c >>> 16) & 0xffff;
    }
    return {
      id: b.id,
      kind: b.kind,
      originX: b.originX,
      originY: b.originY,
      width: b.width,
      height: b.height,
      cells,
      status: b.status,
      priority: b.priority,
      createdTick: b.createdTick,
    };
  });

  return {
    version: CURRENT_SAVE_VERSION,
    slotId: input.slotId,
    fortressName: input.fortressName,
    mode: input.mode,
    seed: input.sim.seed,
    width: input.sim.grid.width,
    height: input.sim.grid.height,
    tick: input.sim.tick,
    realTimestampMs: Date.now(),
    rngStates: {
      ai: input.sim.aiRng.serialize(),
      world: input.sim.worldRng.serialize(),
    },
    tileOverrides: overrides,
    dwarves,
    blueprints,
    plannerNextId: planner.nextId,
    plannerCompleted: planner.completed,
    plannerAccum: (planner as unknown as { accum: number }).accum,
    cameraX: input.cameraX,
    cameraY: input.cameraY,
    zoomIndex: input.zoomIndex,
  };
}

export function restore(save: SaveV1): SimWorld {
  const w = generateWorld({ seed: save.seed, width: save.width, height: save.height });
  const decoded = decodeOverrides(save.tileOverrides);
  decoded.apply(w.grid);

  const sim = new SimWorld(save.seed, w.grid, w.surfaceY, w.spawn);
  sim.tick = save.tick;

  // Restore RNG states.
  const aiState = save.rngStates.ai;
  if (aiState) {
    sim.aiRng.stateHi = aiState[0] >>> 0;
    sim.aiRng.stateLo = aiState[1] >>> 0;
  }
  const worldState = save.rngStates.world;
  if (worldState) {
    sim.worldRng.stateHi = worldState[0] >>> 0;
    sim.worldRng.stateLo = worldState[1] >>> 0;
  }

  // Restore dwarves.
  for (const d of save.dwarves) {
    const e = sim.spawnDwarf({
      name: d.name,
      x: d.x,
      y: d.y,
      traitIds: d.traitIds ?? [],
      skills: d.skills ?? {},
      profession: d.profession ?? "Worker",
      age: d.age ?? 25,
    });
    sim.dwarf.get(e)!.lastJobTick = d.lastJobTick ?? 0;
  }

  // Restore Colony Planner.
  const blueprints: Blueprint[] = (save.blueprints ?? []).map((b) => {
    const cavity = new Int32Array(b.cells.length / 2);
    for (let i = 0; i < cavity.length; i++) {
      const x = b.cells[i * 2];
      const y = b.cells[i * 2 + 1];
      cavity[i] = (y << 16) | x;
    }
    return {
      id: b.id,
      kind: b.kind as BlueprintKind,
      originX: b.originX,
      originY: b.originY,
      width: b.width,
      height: b.height,
      cavity,
      status: b.status,
      priority: b.priority,
      createdTick: b.createdTick,
    };
  });
  sim.planner.blueprints = blueprints;
  sim.planner.nextId = save.plannerNextId ?? blueprints.reduce((m, b) => Math.max(m, b.id + 1), 1);
  sim.planner.completed = save.plannerCompleted ?? blueprints.filter((b) => b.status === "complete").length;
  (sim.planner as unknown as { accum: number }).accum = save.plannerAccum ?? 0;
  sim.planner.rehydrate(sim.grid);

  return sim;
}
