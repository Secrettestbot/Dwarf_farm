// Component data shapes for session 1. All POJO, all serializable.

export interface Position {
  x: number;
  y: number;
}

export interface Dwarf {
  name: string;
  // Tick at which this dwarf last finished a job. Used for tie-breaking idle
  // selection in deterministic order.
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

export type JobKind = "mine" | "idle-walk";

export interface JobAssignment {
  kind: JobKind;
  // Target tile (for mining: the solid tile being dug).
  targetX: number;
  targetY: number;
  // Mining progress in ticks: counts up from 0; tile breaks at MINE_TICKS.
  progress: number;
}
