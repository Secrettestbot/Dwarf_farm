// Component data shapes. All POJO, all serializable.

import { SkillLevels } from "../dwarves/skills";
import { SkillXp } from "../dwarves/skillProgress";

export interface Position {
  x: number;
  y: number;
}

export interface Dwarf {
  name: string;
  /** Trait IDs from the registry in dwarves/traits.ts. */
  traitIds: string[];
  /** Per-skill level 1..20 (1 = Novice, 17+ = Legendary). */
  skills: SkillLevels;
  /** Per-skill cumulative XP. Drives level advancement; level shown in
   * `skills` is derived from this and stays in sync via the work systems. */
  skillXp: SkillXp;
  /** Starting profession label (flavour). */
  profession: string;
  /** Tick at which this dwarf was "born". Negative means born before world
   * began (i.e. the founders, who are already adults at game start). Current
   * age = (sim.tick - bornAtTick) / TICKS_PER_YEAR. */
  bornAtTick: number;
  /** Entity id of the bonded partner, or null. Set by pairingSystem;
   * cleared in killDwarf when one of the pair dies. */
  partnerId: number | null;
  /** Tick at which this dwarf last finished a job. Used for tie-breaking idle
   * selection in deterministic order. */
  lastJobTick: number;
}

export interface Pathing {
  // Packed (y << 16) | x cells. We walk pathIndex forward each move.
  path: Int32Array;
  pathIndex: number;
  // Final destination (the tile we want to be adjacent to, e.g. the rock to mine).
  goalX: number;
  goalY: number;
}

/**
 * Internal drives. All in 0..100. Decays over real time, restored by
 * matching activity. Once a need crosses a low threshold the dwarf will drop
 * non-emergency work to address it. Hunger / thirst are the most urgent —
 * they can kill if neglected.
 */
export interface Needs {
  /** Sleep — drops continuously; restored by sleeping. */
  sleep: number;
  /** Social — drops slowly; restored by talking with another dwarf. */
  social: number;
  /** Hunger — drops faster than sleep; restored by eating. At 0, the dwarf
   * starves to death. */
  hunger: number;
  /** Thirst — drops fastest; restored by drinking. At 0, the dwarf dies of
   * dehydration. */
  thirst: number;
  /** Internal accumulators for sub-tick decay. */
  decayAccumSleep: number;
  decayAccumSocial: number;
  decayAccumHunger: number;
  decayAccumThirst: number;
}

/** What's loose on the floor — output of mining and (later) workshops, input
 * to hauling jobs. The kind matches the stockpile counter that the item
 * eventually credits when a hauler delivers it. Items are entities so
 * pathfinding and the renderer can locate them by Position. */
export type ItemKind = "stone" | "ore" | "dirt";

export interface Item {
  kind: ItemKind;
  /** Entity id of the dwarf currently en route to pick this item up, or
   * -1 if unclaimed. Prevents two haulers racing for the same crate. */
  claimedBy: number;
}

/** Component on a dwarf currently carrying something. While set, the dwarf
 * is in the "deliver to stockpile" half of a haul job. */
export interface Carrying {
  kind: ItemKind;
}

export type JobKind = "mine" | "sleep" | "socialise" | "wander" | "eat" | "drink" | "tend" | "maintain" | "shelter" | "haul";

export interface JobAssignment {
  kind: JobKind;
  // Target tile (mine: solid rock; sleep/wander: walkable spot; socialise: partner tile).
  targetX: number;
  targetY: number;
  // Progress in ticks toward completion. Per-kind thresholds in sim.ts.
  progress: number;
  /** For socialise jobs, the partner dwarf entity id. */
  partnerId?: number;
}
