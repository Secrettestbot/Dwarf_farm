// Persistent save record. The terrain itself is regenerated from `seed`; only
// player-modified tiles are stored as RLE deltas in `tileOverrides`.

export interface SavedBlueprint {
  id: number;
  kind: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  // Cells stored as flat array of (x, y, x, y, ...). Small enough at session 1
  // scale that JSON-friendly storage is fine; later sessions can swap to RLE
  // if the count grows.
  cells: number[];
  status: "digging" | "complete";
  priority: number;
  createdTick: number;
}

export interface SaveV1 {
  version: 1;
  slotId: string;
  seed: number;
  width: number;
  height: number;

  // Tick counters & wall-clock so catch-up can compute elapsed time on reopen.
  tick: number;
  realTimestampMs: number;

  // Forked RNG states keyed by label.
  rngStates: Record<string, [number, number]>;

  // RLE delta from worldgen output. Pure tile-state — no zones, no blueprints.
  tileOverrides: Uint8Array;

  // Entities packed minimally: dwarves with name + position + lastJobTick.
  // Encoded as JSON-friendly objects since the count is small in session 1.
  dwarves: Array<{ name: string; x: number; y: number; lastJobTick: number }>;

  // Colony Planner state.
  blueprints: SavedBlueprint[];
  plannerNextId: number;
  plannerCompleted: number;
  plannerAccum: number;

  cameraX: number;
  cameraY: number;
  zoomIndex: number;
}

export const CURRENT_SAVE_VERSION = 1;
