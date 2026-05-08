// Persistent save record. The terrain is regenerated from `seed`; only
// player-modified tiles are stored as RLE deltas in `tileOverrides`.

import { SkillLevels } from "../sim/dwarves/skills";
import { SliderState } from "../sim/sliders";
import { EmergencyState } from "../sim/emergency";

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
  needs?: {
    sleep: number;
    social: number;
    hunger?: number;
    thirst?: number;
    morale?: number;
    decayAccumSleep: number;
    decayAccumSocial: number;
    decayAccumHunger?: number;
    decayAccumThirst?: number;
    decayAccumMorale?: number;
  };
  /** In-flight job at save time. */
  job?: {
    kind: "mine" | "sleep" | "socialise" | "wander" | "eat" | "drink" | "tend" | "maintain" | "shelter" | "haul" | "craft" | "engage" | "research";
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
  /** Combat HP. Optional for back-compat with v2 saves. */
  health?: { hp: number; maxHp: number; lastAttackTick: number; wasSevereWound?: boolean };
  /** What this dwarf is currently carrying mid-haul, if anything. */
  carrying?: { kind: "stone" | "ore" | "dirt" | "gem" };
  /** Squad membership at save time. The draft is re-checked at the next
   * year boundary regardless, but persisting the current state means an
   * in-progress engagement survives a save/load cycle. */
  squad?: { draftedAtTick: number };
}

/** A loose item on the floor — dropped by mining, picked up by hauling. */
export interface SavedItem {
  kind: "stone" | "ore" | "dirt" | "gem";
  x: number;
  y: number;
}

/** Saved hostile entity. */
export interface SavedHostile {
  kind: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  lastAttackTick: number;
  lastMoveTick: number;
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
  /** Per-cell last-tended ticks for farm blueprints. Parallel to cells/2
   * (one entry per cavity tile). Optional for back-compat with v2 saves. */
  cellTendedAt?: number[];
  /** Tick at which this room was last maintained. Used to gate the
   * architect's room counts: neglected rooms don't count toward targets, so
   * a small colony can't sprawl beyond what its dwarves can keep up.
   * Optional for back-compat with v2 saves. */
  lastMaintainedTick?: number;
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
  food?: number;
  drink?: number;
  bars?: number;
  tools?: number;
  gems?: number;
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
  /** Fog-of-war seen mask, RLE-encoded runs of 1s. Optional for back-compat
   * with v2 saves — older saves treat all in-bounds tiles as seen. */
  seenMask?: Uint8Array;

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
  hostiles?: SavedHostile[];
  /** Player priority sliders. Optional for back-compat with v2 saves —
   * older saves restore to the neutral defaults. */
  sliders?: SliderState;
  /** Active emergency-button state. Optional for back-compat. */
  emergency?: EmergencyState;
  /** Loose items on the floor at save time. */
  items?: SavedItem[];
  /** Research progress. Optional for back-compat with v2 saves. */
  research?: { current: string | null; progress: number; completed: string[] };
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
