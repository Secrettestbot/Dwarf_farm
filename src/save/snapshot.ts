import { SimWorld } from "../sim/world/simWorld";
import { generateWorld } from "../sim/world/worldgen";
import { CURRENT_SAVE_VERSION, SaveV1 } from "./schema";
import { decodeOverrides, encodeOverrides } from "./codec";

// Serialize / deserialize a SimWorld to/from a SaveV1. The save records only
// what's needed to deterministically reconstruct the simulation: seed, RLE
// delta vs a clean regen, RNG states, and the dwarf list.

export interface SnapshotInput {
  sim: SimWorld;
  slotId: string;
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
  const overrides = encodeOverrides(input.sim.grid, baseline.grid, input.sim.digZones.zones);

  const dwarves: SaveV1["dwarves"] = [];
  input.sim.forEachDwarf((_id, pos, dw) => {
    dwarves.push({ name: dw.name, x: pos.x, y: pos.y, lastJobTick: dw.lastJobTick });
  });

  return {
    version: CURRENT_SAVE_VERSION,
    slotId: input.slotId,
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
    const e = sim.spawnDwarf(d.name, d.x, d.y);
    sim.dwarf.get(e)!.lastJobTick = d.lastJobTick;
  }

  for (const z of decoded.zones) sim.digZones.add(z);

  return sim;
}
