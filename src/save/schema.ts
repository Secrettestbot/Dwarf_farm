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
  /** Per-skill cumulative XP. Optional for back-compat with v2 saves. */
  skillXp?: Record<string, number>;
  profession: string;
  /** Tick at which this dwarf was "born". Negative for founders. */
  bornAtTick: number;
  /** Legacy field kept for back-compat with v2 saves; restore code falls
   * back to computing bornAtTick from age + tick if bornAtTick is missing. */
  age?: number;
  /** Partner referenced by index into the saved dwarves array, or null. */
  partnerIndex?: number | null;
  lastJobTick: number;
  needs?: { sleep: number; social: number; decayAccumSleep: number; decayAccumSocial: number };
  /** In-flight job (mine / sleep / socialise / wander) at save time. */
  job?: {
    kind: "mine" | "sleep" | "socialise" | "wander";
    targetX: number;
    targetY: number;
    progress: number;
    /** Partner referenced by index into the saved dwarves array. */
    partnerIndex?: number;
  };
  /** In-flight pathing if mid-walk at save time. */
  pathing?: {
    path: number[];
    pathIndex: number;
    goalX: number;
    goalY: number;
  };
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

export interface SavedLogEvent {
  tick: number;
  category: string;
  text: string;
}

export interface SavedStockpile {
  ore: number;
  stone: number;
  dirt: number;
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

  events?: SavedLogEvent[];
  stockpile?: SavedStockpile;
  oreEverStruck?: boolean;
  lastYearAnnounced?: number;
  populationMilestones?: number[];
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
