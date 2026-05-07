// Component data shapes. All POJO, all serializable.

import { SkillLevels } from "../dwarves/skills";

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
  /** Starting profession label (flavour). */
  profession: string;
  /** Age in in-game years. Increments via aging system in later sessions. */
  age: number;
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
 * non-emergency work to address it. Hunger / thirst lands when farming &
 * stockpiles arrive in a later session.
 */
export interface Needs {
  /** Sleep — drops continuously; restored by sleeping. */
  sleep: number;
  /** Social — drops slowly; restored by talking with another dwarf. */
  social: number;
  /** Internal accumulator for sub-tick decay. Carries fractional need loss. */
  decayAccumSleep: number;
  decayAccumSocial: number;
}

export type JobKind = "mine" | "sleep" | "socialise" | "wander";

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
