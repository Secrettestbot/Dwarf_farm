// Persistent save record. The terrain itself is regenerated from `seed`; only
// player-modified tiles are stored as RLE deltas in `tileOverrides`.

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

  // RLE delta from worldgen output. Includes embedded dig-zone list.
  tileOverrides: Uint8Array;

  // Entities packed minimally: dwarves with name + position + lastJobTick.
  // Encoded as JSON-friendly objects since the count is small in session 1.
  dwarves: Array<{ name: string; x: number; y: number; lastJobTick: number }>;

  cameraX: number;
  cameraY: number;
  zoomIndex: number;
}

export const CURRENT_SAVE_VERSION = 1;
