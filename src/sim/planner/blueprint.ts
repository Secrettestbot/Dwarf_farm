// A Blueprint is the colony's internal commitment to dig out a specific cavity
// of a specific kind at a specific location. Dwarves only excavate rock that
// belongs to an active blueprint — this is what stops them from strip-mining
// the mountain. Blueprints are emitted by the Colony Planner; the player
// never creates or sees them as a UI primitive (they're rendered as a faint
// outline so the observer can tell what the dwarves intend to do).

import { TileGrid } from "../world/grid";

export type BlueprintKind =
  | "bedroom"
  | "dining_hall"
  | "stockpile"
  | "corridor"
  | "stairwell";

export const BLUEPRINT_KIND_LABELS: Record<BlueprintKind, string> = {
  bedroom: "Bedroom",
  dining_hall: "Dining Hall",
  stockpile: "Stockpile",
  corridor: "Corridor",
  stairwell: "Stairwell",
};

export type BlueprintStatus = "digging" | "complete";

/** Packed (y << 16) | x cells. */
export type CavityCells = Int32Array;

export interface Blueprint {
  id: number;
  kind: BlueprintKind;
  // Bounding rect of the cavity.
  originX: number;
  originY: number;
  width: number;
  height: number;
  // Cells composing the cavity. Always within the bounding rect.
  cavity: CavityCells;
  status: BlueprintStatus;
  // Higher = more urgent. Tie-broken by id for deterministic ordering.
  priority: number;
  // Tick at which this blueprint was emitted (for narrative / event log later).
  createdTick: number;
}

export function packCell(x: number, y: number): number {
  return (y << 16) | x;
}

export function unpackCellX(c: number): number {
  return c & 0xffff;
}

export function unpackCellY(c: number): number {
  return (c >>> 16) & 0xffff;
}

/** True if every cavity cell is no longer solid (i.e. fully excavated). */
export function isComplete(b: Blueprint, grid: TileGrid): boolean {
  for (let i = 0; i < b.cavity.length; i++) {
    const c = b.cavity[i];
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    if (grid.isSolid(x, y)) return false;
  }
  return true;
}

/** Build a rectangular cavity from corner + dims. */
export function rectCavity(x: number, y: number, w: number, h: number): CavityCells {
  const out = new Int32Array(w * h);
  let i = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      out[i++] = (yy << 16) | xx;
    }
  }
  return out;
}
