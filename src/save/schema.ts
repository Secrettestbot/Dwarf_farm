// Persistent save record. The terrain is regenerated from `seed`; only
// player-modified tiles are stored as RLE deltas in `tileOverrides`.

import { SkillLevels } from "../sim/dwarves/skills";

export type GameMode = "legacy" | "saga";

export interface SavedDwarf {
  name: string;
  x: number;
  y: number;
  traitIds: string[];
  skills: SkillLevels;
  profession: string;
  age: number;
  lastJobTick: number;
}

export interface SavedBlueprint {
  id: number;
  kind: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: number[];
  status: "digging" | "complete";
  priority: number;
  createdTick: number;
}

export interface SaveV1 {
  version: 2;
  slotId: string;
  /** Friendly fortress name shown on the title screen — set when the founders begin. */
  fortressName: string;
  /** Permadeath choice. Stored at fortress creation; never changes. */
  mode: GameMode;
  seed: number;
  width: number;
  height: number;

  // Tick counters & wall-clock so catch-up can compute elapsed time on reopen.
  tick: number;
  realTimestampMs: number;

  // Forked RNG states keyed by label.
  rngStates: Record<string, [number, number]>;

  // RLE delta from worldgen output.
  tileOverrides: Uint8Array;

  // Full dwarf list with traits, skills, profession, age.
  dwarves: SavedDwarf[];

  // Colony Planner state.
  blueprints: SavedBlueprint[];
  plannerNextId: number;
  plannerCompleted: number;
  plannerAccum: number;

  cameraX: number;
  cameraY: number;
  zoomIndex: number;
}

export const CURRENT_SAVE_VERSION = 2 as const;

/** A lightweight summary of a save slot, shown on the title screen. */
export interface SlotSummary {
  slotId: string;
  fortressName: string;
  mode: GameMode;
  population: number;
  tick: number;
  realTimestampMs: number;
}

export const SAVE_SLOT_IDS = ["slot0", "slot1", "slot2", "slot3", "slot4"] as const;
export type SaveSlotId = typeof SAVE_SLOT_IDS[number];
