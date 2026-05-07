// The Colony Planner is the colony's collective intention. It periodically
// asks "what does the colony need next?" and, when a need crosses a threshold,
// emits a Blueprint — a specific cavity at a specific location with a specific
// purpose. Dwarves consult the planner via chooseJob: they only mine inside
// active blueprints. Without the planner, no rock is ever broken.
//
// Session 1 implements the smallest useful version: one signal (population vs.
// rooms-built, here approximated as in-game days elapsed for visible progress)
// plus one blueprint kind (bedroom, a 4×3 cavity placed by a heuristic that
// prefers locations close to the existing colony, downward, and not
// overlapping prior blueprints). The richer signal mix (geology, architectural
// sense, Architect dwarf) lands in sessions 2–4 per the plan.

import { TileGrid } from "../world/grid";
import { Blueprint, BlueprintKind, isComplete, rectCavity, packCell } from "./blueprint";

export interface PlannerContext {
  grid: TileGrid;
  spawn: { x: number; y: number };
  tick: number;
}

const PLAN_INTERVAL_TICKS = 60; // re-evaluate once per in-game hour
const DAY_TICKS = 60 * 24;

const BEDROOM_W = 4;
const BEDROOM_H = 3;
const SEARCH_RADIUS = 35;

export class ColonyPlanner {
  blueprints: Blueprint[] = [];
  nextId = 1;
  // Ticks-since-last-evaluation accumulator.
  private accum = 0;
  // Number of blueprints completed (for the gating signal).
  completed = 0;
  // Spatial index: tile-index → blueprintId. -1 means no blueprint claims this
  // tile. Lazily allocated when grid size becomes known.
  private claimedBy: Int32Array | null = null;
  private claimedW = 0;

  /** Run one planning step. Called from sim.tick BEFORE job assignment. */
  tick(ctx: PlannerContext): void {
    this.accum++;
    // Sweep complete blueprints first so completion immediately frees up the
    // "no active blueprint" gate for new emission.
    this.harvestCompleted(ctx.grid);

    if (this.accum < PLAN_INTERVAL_TICKS) return;
    this.accum = 0;

    if (this.shouldEmitBedroom(ctx)) {
      this.placeBedroom(ctx);
    }
  }

  /**
   * Gating signal v0: emit a new bedroom if no blueprint is currently active
   * AND the colony's age justifies one (1 room per in-game day, scaled later
   * by population pressure). This is the placeholder that exercises the
   * pipeline; session 2 replaces it with population-vs-beds.
   */
  private shouldEmitBedroom(ctx: PlannerContext): boolean {
    const active = this.blueprints.some((b) => b.status === "digging");
    if (active) return false;
    const day = Math.floor(ctx.tick / DAY_TICKS);
    const targetRooms = Math.max(1, day + 1);
    return this.completed + 1 <= targetRooms;
  }

  /**
   * Heuristic placement: scan candidate origins inside SEARCH_RADIUS of spawn.
   * A candidate is valid iff (a) all of its cavity tiles are solid, (b) the
   * cavity touches at least one walkable tile (so dwarves can reach a face),
   * (c) it doesn't overlap an existing blueprint. The score prefers locations
   * close to spawn and below it (the colony grows downward and outward like
   * a real dwarf hold). Determinism: scan order is fixed; ties broken by
   * (originY, originX, ...) — never by Math.random.
   */
  private placeBedroom(ctx: PlannerContext): Blueprint | null {
    const { grid, spawn } = ctx;
    let best: { x: number; y: number; score: number } | null = null;

    for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
      for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
        const ox = spawn.x + dx;
        const oy = spawn.y + dy;
        if (!this.candidateValid(grid, ox, oy, BEDROOM_W, BEDROOM_H)) continue;
        // Score: closer to spawn is better; below-spawn gets a bonus; small
        // additional penalty if directly above spawn (we prefer sideways/down).
        const distSq = dx * dx + dy * dy;
        let score = -distSq;
        if (dy > 0) score += 60;
        if (dy < -1) score -= 25;
        if (best === null) {
          best = { x: ox, y: oy, score };
        } else if (
          score > best.score ||
          (score === best.score && (oy < best.y || (oy === best.y && ox < best.x)))
        ) {
          best = { x: ox, y: oy, score };
        }
      }
    }

    if (!best) return null;

    const cavity = rectCavity(best.x, best.y, BEDROOM_W, BEDROOM_H);
    const bp: Blueprint = {
      id: this.nextId++,
      kind: "bedroom" as BlueprintKind,
      originX: best.x,
      originY: best.y,
      width: BEDROOM_W,
      height: BEDROOM_H,
      cavity,
      status: "digging",
      priority: 1,
      createdTick: ctx.tick,
    };
    this.blueprints.push(bp);
    this.markClaimed(grid, bp);
    this.markDesignations(grid, bp, true);
    return bp;
  }

  private candidateValid(grid: TileGrid, ox: number, oy: number, w: number, h: number): boolean {
    // All cavity tiles must be solid (we excavate them) AND not already claimed.
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        if (!grid.inBounds(x, y)) return false;
        if (!grid.isSolid(x, y)) return false;
        if (this.isClaimed(grid, x, y)) return false;
      }
    }
    // At least one tile in the 1-tile border must be walkable (an existing
    // floor we can connect to).
    let touchesWalkable = false;
    for (let y = oy - 1; y <= oy + h && !touchesWalkable; y++) {
      for (let x = ox - 1; x <= ox + w && !touchesWalkable; x++) {
        if (!grid.inBounds(x, y)) continue;
        if (x >= ox && x < ox + w && y >= oy && y < oy + h) continue;
        if (grid.isWalkable(x, y)) {
          touchesWalkable = true;
        }
      }
    }
    return touchesWalkable;
  }

  /** True if any active blueprint owns this tile. O(1) via spatial index. */
  containsTile(grid: TileGrid, x: number, y: number): boolean {
    if (!grid.inBounds(x, y)) return false;
    return this.isClaimed(grid, x, y);
  }

  hasActive(): boolean {
    for (const b of this.blueprints) if (b.status === "digging") return true;
    return false;
  }

  activeCount(): number {
    let n = 0;
    for (const b of this.blueprints) if (b.status === "digging") n++;
    return n;
  }

  /**
   * Sweep blueprints whose cavity is fully excavated and mark them complete.
   * In a later session this is also where "build the room" jobs get queued
   * (place a bed, mark the room as a Bedroom for the room-quality system).
   */
  private harvestCompleted(grid: TileGrid): void {
    for (const b of this.blueprints) {
      if (b.status === "digging" && isComplete(b, grid)) {
        b.status = "complete";
        this.completed++;
        // Clear designation overlay since the cavity is no longer being dug.
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          grid.setDesignation(x, y, 0);
        }
        // Note: we leave the claimedBy entries in place so future placements
        // continue to avoid stomping the same footprint (rooms persist).
      }
    }
  }

  // ---- Spatial index helpers ---------------------------------------------

  private ensureClaimedIndex(grid: TileGrid): Int32Array {
    if (!this.claimedBy || this.claimedW !== grid.width || this.claimedBy.length !== grid.width * grid.height) {
      const arr = new Int32Array(grid.width * grid.height);
      arr.fill(-1);
      this.claimedBy = arr;
      this.claimedW = grid.width;
      // Re-seed from existing blueprints (e.g. after restore).
      for (const b of this.blueprints) {
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          arr[y * grid.width + x] = b.id;
        }
      }
    }
    return this.claimedBy;
  }

  private isClaimed(grid: TileGrid, x: number, y: number): boolean {
    const arr = this.ensureClaimedIndex(grid);
    return arr[y * grid.width + x] !== -1;
  }

  private markClaimed(grid: TileGrid, b: Blueprint): void {
    const arr = this.ensureClaimedIndex(grid);
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      arr[y * grid.width + x] = b.id;
    }
  }

  /**
   * Set or clear the Designation overlay on cavity tiles so the renderer can
   * show the planned cavity. Called when a blueprint is added / completed.
   */
  private markDesignations(grid: TileGrid, b: Blueprint, on: boolean): void {
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      grid.setDesignation(x, y, on ? 1 : 0);
    }
  }

  /**
   * Re-apply spatial index + designation overlay after restore from save.
   * Called by snapshot.restore once the planner has been populated.
   */
  rehydrate(grid: TileGrid): void {
    this.claimedBy = null;
    this.ensureClaimedIndex(grid);
    for (const b of this.blueprints) {
      if (b.status === "digging") this.markDesignations(grid, b, true);
    }
  }
}

// Re-exports for convenience.
export { packCell };
export type { Blueprint };
