// The Colony Planner is the colony's collective intention. It periodically
// asks "what does the colony need next?" and, when a need crosses a threshold,
// emits a Blueprint — a specific cavity at a specific location with a specific
// purpose. Dwarves consult the planner via chooseTask: they only mine inside
// active blueprints.
//
// v2 (this session) adds:
//   - Multiple kinds: bedroom, dining_hall, stockpile, corridor.
//   - Multiple active blueprints (up to MAX_ACTIVE_BLUEPRINTS) so a colony of
//     several dwarves can divide work and the player sees parallel progress.
//   - Population-driven kind dispatch: at certain pop thresholds the planner
//     emits the colony's first dining hall, then its first stockpile, etc.
//   - Per-kind placement heuristics: bedrooms cluster near the spawn axis,
//     dining halls bias to one side of the spawn, stockpiles to the other,
//     so the colony develops a recognizable "shape" rather than a jumble.
//
// The richer signal mix (geology, the Architect dwarf, soft tendency dials)
// arrives in later sessions per the roadmap.

import { TileGrid } from "../world/grid";
import { Blueprint, BlueprintKind, isComplete, rectCavity } from "./blueprint";

export interface PlannerContext {
  grid: TileGrid;
  spawn: { x: number; y: number };
  tick: number;
  /** Live colony population — drives how aggressively the planner expands. */
  population: number;
}

const PLAN_INTERVAL_TICKS = 60; // re-evaluate once per in-game hour

const ROOM_DIMS: Record<BlueprintKind, { w: number; h: number; priority: number }> = {
  bedroom: { w: 4, h: 3, priority: 1 },
  dining_hall: { w: 8, h: 5, priority: 3 },
  stockpile: { w: 5, h: 4, priority: 2 },
  corridor: { w: 4, h: 2, priority: 4 },
  stairwell: { w: 2, h: 6, priority: 5 },
};

const SEARCH_RADIUS = 60;
const MAX_ACTIVE_BLUEPRINTS = 3;

/** Architectural style preference — biases planner placement decisions. */
interface StylePref {
  /**
   * Horizontal bias for each kind, expressed as a sign factor.
   * -1 = prefer left of spawn, +1 = prefer right, 0 = no bias.
   */
  bedroom: number;
  dining_hall: number;
  stockpile: number;
}

const DEFAULT_STYLE: StylePref = {
  // Bedrooms cluster on both sides; we let the candidate scorer break ties.
  bedroom: 0,
  // Dining hall on one side, stockpile on the other, gives the colony a spine.
  dining_hall: -1,
  stockpile: +1,
};

export class ColonyPlanner {
  blueprints: Blueprint[] = [];
  nextId = 1;
  private accum = 0;
  completed = 0;

  // Per-kind completed counts so dispatch can ask "do we have a dining hall yet?".
  completedByKind: Record<string, number> = {};

  // Spatial index: tile-index → blueprintId. -1 = unclaimed. Lazily allocated.
  private claimedBy: Int32Array | null = null;
  private claimedW = 0;

  /** Run one planning step. Called from sim.tick BEFORE job assignment. */
  tick(ctx: PlannerContext): void {
    this.accum++;
    this.harvestCompleted(ctx.grid);

    if (this.accum < PLAN_INTERVAL_TICKS) return;
    this.accum = 0;

    // Allow several active blueprints so the colony actually progresses with
    // multiple dwarves, but cap so the planner doesn't sprawl.
    while (this.activeCount() < MAX_ACTIVE_BLUEPRINTS) {
      const kind = this.pickNextKind(ctx);
      if (!kind) break;
      const placed = this.placeRoom(ctx, kind);
      if (!placed) break; // couldn't find a spot for this kind right now; bail.
    }
  }

  /**
   * Decide what kind of room to emit next, in priority order:
   *   1. Dining hall when population ≥ 4 and none exists.
   *   2. Stockpile when population ≥ 5 and none exists.
   *   3. Bedrooms until ceil(pop × 1.5) bedrooms exist.
   * Returns null if nothing is needed right now.
   */
  private pickNextKind(ctx: PlannerContext): BlueprintKind | null {
    const pop = Math.max(1, ctx.population);
    const built = this.completedByKind;
    const active = this.activeByKind();

    // Priority 1: dining hall for ≥4 dwarves.
    if (pop >= 4 && (built["dining_hall"] ?? 0) === 0 && (active["dining_hall"] ?? 0) === 0) {
      return "dining_hall";
    }
    // Priority 2: stockpile for ≥5 dwarves.
    if (pop >= 5 && (built["stockpile"] ?? 0) === 0 && (active["stockpile"] ?? 0) === 0) {
      return "stockpile";
    }
    // Priority 3: bedrooms up to target.
    const bedroomTarget = Math.max(2, Math.ceil(pop * 1.5));
    const bedroomTotal = (built["bedroom"] ?? 0) + (active["bedroom"] ?? 0);
    if (bedroomTotal < bedroomTarget) return "bedroom";

    return null;
  }

  /** Find a placement and emit a blueprint of the given kind. */
  private placeRoom(ctx: PlannerContext, kind: BlueprintKind): Blueprint | null {
    const dims = ROOM_DIMS[kind];
    const { grid, spawn } = ctx;
    let best: { x: number; y: number; score: number } | null = null;

    const xBias = (DEFAULT_STYLE as unknown as Record<string, number>)[kind] ?? 0;

    for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
      for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
        const ox = spawn.x + dx;
        const oy = spawn.y + dy;
        if (!this.candidateValid(grid, ox, oy, dims.w, dims.h)) continue;
        const score = this.scoreCandidate(kind, dx, dy, xBias);
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

    const cavity = rectCavity(best.x, best.y, dims.w, dims.h);
    const bp: Blueprint = {
      id: this.nextId++,
      kind,
      originX: best.x,
      originY: best.y,
      width: dims.w,
      height: dims.h,
      cavity,
      status: "digging",
      priority: dims.priority,
      createdTick: ctx.tick,
    };
    this.blueprints.push(bp);
    this.markClaimed(grid, bp);
    this.markDesignations(grid, bp, true);
    return bp;
  }

  /**
   * Scoring per kind:
   *   - bedroom: prefer close to spawn, prefer below or alongside, light
   *     bias on whichever side has fewer bedrooms.
   *   - dining_hall: very strong "close to spawn, prefer left of spawn".
   *   - stockpile: "close to spawn, prefer right of spawn".
   *   - corridor: shortest viable connector (handled separately later).
   *   - stairwell: descending bias.
   */
  private scoreCandidate(kind: BlueprintKind, dx: number, dy: number, xBias: number): number {
    const distSq = dx * dx + dy * dy;
    let score = -distSq;
    // Slight downward bias for everything — the colony grows into the mountain.
    if (dy > 0) score += 40;
    if (dy < -2) score -= 40;

    // Apply per-kind side bias.
    if (xBias !== 0) {
      // Reward placement on the preferred side, gently.
      score += xBias * dx * 2;
    }

    if (kind === "stairwell") {
      // Stairwells want to be deep — much stronger downward bias.
      score += dy * 4;
    }
    return score;
  }

  private candidateValid(grid: TileGrid, ox: number, oy: number, w: number, h: number): boolean {
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        if (!grid.inBounds(x, y)) return false;
        if (!grid.isSolid(x, y)) return false;
        if (this.isClaimed(grid, x, y)) return false;
      }
    }
    // At least one tile in the 1-tile border must be walkable so there's an
    // approach — without this, a dwarf can't reach any cavity tile.
    let touchesWalkable = false;
    for (let y = oy - 1; y <= oy + h && !touchesWalkable; y++) {
      for (let x = ox - 1; x <= ox + w && !touchesWalkable; x++) {
        if (!grid.inBounds(x, y)) continue;
        if (x >= ox && x < ox + w && y >= oy && y < oy + h) continue;
        if (grid.isWalkable(x, y)) touchesWalkable = true;
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

  private activeByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of this.blueprints) {
      if (b.status !== "digging") continue;
      out[b.kind] = (out[b.kind] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Sweep blueprints whose cavity is fully excavated and mark them complete.
   */
  private harvestCompleted(grid: TileGrid): void {
    for (const b of this.blueprints) {
      if (b.status === "digging" && isComplete(b, grid)) {
        b.status = "complete";
        this.completed++;
        this.completedByKind[b.kind] = (this.completedByKind[b.kind] ?? 0) + 1;
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          grid.setDesignation(x, y, 0);
        }
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
   */
  rehydrate(grid: TileGrid): void {
    this.claimedBy = null;
    this.ensureClaimedIndex(grid);
    // Rebuild completedByKind.
    this.completedByKind = {};
    for (const b of this.blueprints) {
      if (b.status === "complete") {
        this.completedByKind[b.kind] = (this.completedByKind[b.kind] ?? 0) + 1;
      }
      if (b.status === "digging") this.markDesignations(grid, b, true);
    }
  }

  /** A snapshot of room counts for the HUD / digest rendering. */
  buildSummary(): { kind: BlueprintKind; active: number; complete: number }[] {
    const kinds: BlueprintKind[] = ["bedroom", "dining_hall", "stockpile", "corridor", "stairwell"];
    const active = this.activeByKind();
    const out: { kind: BlueprintKind; active: number; complete: number }[] = [];
    for (const k of kinds) {
      const a = active[k] ?? 0;
      const c = this.completedByKind[k] ?? 0;
      if (a + c > 0) out.push({ kind: k, active: a, complete: c });
    }
    return out;
  }
}

export type { Blueprint };
