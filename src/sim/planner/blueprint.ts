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
  | "mine"
  | "farm"
  | "stairwell"
  | "kitchen"
  | "brewery"
  | "smelter"
  | "forge"
  | "trade_depot"
  | "library"
  | "armoury"
  | "throne_room"
  | "pump_station"
  | "mason"
  | "jeweller"
  | "carpenter"
  | "lumberyard"
  | "kiln";

export const BLUEPRINT_KIND_LABELS: Record<BlueprintKind, string> = {
  bedroom: "Bedroom",
  dining_hall: "Dining Hall",
  stockpile: "Stockpile",
  corridor: "Corridor",
  mine: "Mine",
  farm: "Farm",
  stairwell: "Stairwell",
  kitchen: "Kitchen",
  brewery: "Brewery",
  smelter: "Smelter",
  forge: "Forge",
  trade_depot: "Trade Depot",
  library: "Library",
  armoury: "Armoury",
  throne_room: "Throne Room",
  pump_station: "Pump Station",
  mason: "Mason's Workshop",
  jeweller: "Jeweller's Workshop",
  carpenter: "Carpenter's Workshop",
  lumberyard: "Lumberyard",
  kiln: "Kiln",
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
  /** For farms: tick at which each cavity cell was last tended by a dwarf.
   * Parallel to `cavity` so cavity[i] ↔ cellTendedAt[i]. The farm system
   * only yields food on cells tended within TEND_VALIDITY ticks; untended
   * cells go fallow and produce nothing. Undefined for non-farm kinds. */
  cellTendedAt?: Int32Array;
  /** Tick at which a dwarf last performed general upkeep on this room.
   * Set to `createdTick` when the dig finishes, advanced each time a
   * 'maintain' job completes. Rooms neglected longer than
   * MAINTAIN_VALIDITY_TICKS stop counting toward the architect's targets,
   * so the colony can't sprawl beyond what its dwarves can keep up. */
  lastMaintainedTick?: number;
  /** Room quality in 0..100. A freshly-dug room starts at QUALITY_BASE
   * and creeps up each time it's maintained — engravings, gem inlays,
   * carved chairs, the oldest rooms become the most beautiful (GDD
   * §7.3). Sleeping or eating in a higher-quality room boosts morale
   * more than a bare cavity does. Optional in saved data: missing
   * means base quality (the architect's freshly-finished default). */
  quality?: number;
}

/** Quality of a freshly-finished room. The architect counts the dig
 * itself as the first round of work; subsequent maintenance cycles
 * raise quality from here. */
export const QUALITY_BASE = 30;
/** Cap quality can climb to. Leaves a small dead-zone above 90 so a
 * legendary room is *visibly* a thing, not a slow asymptote. */
export const QUALITY_MAX = 100;
/** Per-maintain-cycle quality bump. ~30 cycles past the baseline takes
 * a room from 'rough cavity' to 'legendary', which is exactly the
 * fortress-history pacing the GDD describes. */
export const QUALITY_PER_MAINTAIN = 2;

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

/** A completed room counts as neglected if no dwarf has performed
 * maintenance on it within this many ticks. Tied to the chooseTask
 * scheduling cadence so the targeting and the planner gating agree. */
export const MAINTAIN_VALIDITY_TICKS = 24 * 60; // one in-game day

/** True if a completed blueprint's maintenance clock has run out. Rooms
 * that are still being dug (status = digging) are never "neglected" —
 * the dig itself is the work. Bare structures (corridors, tunnels,
 * stairwells) don't need maintenance and are never considered neglected
 * either; only enclosed habitable rooms decay. */
export function isRoomNeglected(b: Blueprint, currentTick: number): boolean {
  if (b.status !== "complete") return false;
  if (!isMaintainable(b.kind)) return false;
  const since = currentTick - (b.lastMaintainedTick ?? b.createdTick);
  return since > MAINTAIN_VALIDITY_TICKS;
}

/** Whether a room of this kind takes general upkeep. Corridors, tunnels,
 * stairwells, and mines are bare passages that don't require it. */
export function isMaintainable(kind: BlueprintKind): boolean {
  return (
    kind === "bedroom" ||
    kind === "dining_hall" ||
    kind === "stockpile" ||
    kind === "farm" ||
    kind === "kitchen" ||
    kind === "brewery" ||
    kind === "smelter" ||
    kind === "forge" ||
    kind === "trade_depot" ||
    kind === "library" ||
    kind === "armoury" ||
    kind === "throne_room" ||
    kind === "pump_station" ||
    kind === "mason" ||
    kind === "jeweller" ||
    kind === "carpenter" ||
    kind === "kiln"
  );
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
