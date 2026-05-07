// The Colony Planner is the colony's collective intention. It periodically
// asks "what does the colony need next?" and, when a need crosses a threshold,
// emits a Blueprint — a specific cavity at a specific location with a specific
// purpose. Dwarves consult the planner via chooseTask: they only mine inside
// active blueprints.
//
// v3 (this session) adds the colony's exploration urge:
//   - Corridor blueprints: 1-tile-wide tunnels extending outward into solid
//     rock, preferring downward, then lateral, then upward. They exist to
//     extend the colony's walkable reach so future room/mine blueprints have
//     somewhere new to land.
//   - Mine blueprints: 3×3 cavities centered on Ore tiles within sensing
//     range of walkable space. The colony harvests minerals by following ore
//     veins as soon as a corridor exposes them.
//   - Periodic corridor emission: every two completed rooms, the planner
//     wants another corridor so the colony keeps growing outward instead of
//     sealing itself into a tight cluster around spawn.
//
// Future sessions add the geology signal proper (sense ore vein density to
// steer corridor direction), the Architect dwarf signal (style preferences
// per leader), and stairwells as a distinct kind for descending floors.

import { TileGrid } from "../world/grid";
import { TileType } from "../world/tiles";
import { Rng } from "../rng";
import { Blueprint, BlueprintKind, isComplete, rectCavity } from "./blueprint";

export interface PlannerContext {
  grid: TileGrid;
  spawn: { x: number; y: number };
  tick: number;
  /** Live colony population — drives how aggressively the planner expands. */
  population: number;
  /** Forked, deterministic RNG used to vary placement (corridor length,
   * width, direction sampling). State is part of SimWorld and serialized. */
  rng: Rng;
}

const PLAN_INTERVAL_TICKS = 60; // re-evaluate once per in-game hour

const ROOM_DIMS: Record<BlueprintKind, { w: number; h: number; priority: number }> = {
  bedroom: { w: 4, h: 3, priority: 1 },
  dining_hall: { w: 8, h: 5, priority: 3 },
  stockpile: { w: 5, h: 4, priority: 2 },
  // Corridors are placed by a custom routine; this dim entry just holds the
  // per-segment metadata used by the renderer / blueprint commit path.
  corridor: { w: 8, h: 1, priority: 4 },
  // Mines are 3×3 cavities centered on an ore tile.
  mine: { w: 3, h: 3, priority: 2 },
  stairwell: { w: 2, h: 6, priority: 5 },
};

const ROOM_SEARCH_RADIUS = 60;
const CORRIDOR_SEARCH_RADIUS = 50;
const CORRIDOR_MIN_LEN = 4;
const CORRIDOR_MAX_LEN = 10;
const ORE_SENSE_RADIUS = 8; // an ore tile is sense-able this many tiles from walkable
const MAX_ACTIVE_BLUEPRINTS = 3;

interface StylePref {
  bedroom: number;
  dining_hall: number;
  stockpile: number;
}

const DEFAULT_STYLE: StylePref = {
  bedroom: 0,
  dining_hall: -1,
  stockpile: +1,
};

// Direction preferences for corridor placement. Higher pref = more attractive.
// Downward is most-preferred so the colony sinks into the mountain.
interface CorridorDir {
  dx: number;
  dy: number;
  pref: number;
}
const CORRIDOR_DIRS: CorridorDir[] = [
  { dx: 0, dy: 1, pref: 100 },   // down
  { dx: 1, dy: 0, pref: 60 },    // right
  { dx: -1, dy: 0, pref: 60 },   // left
  { dx: 0, dy: -1, pref: -120 }, // up — strongly disfavored
];

const REACH_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** Perpendicular direction vector used to widen 2-wide corridors. */
function perpendicularOf(dx: number, dy: number): { dx: number; dy: number } {
  // Rotate 90° clockwise. For vertical corridors this gives a perpendicular
  // along the x-axis; for horizontal, along the y-axis.
  return { dx: -dy, dy: dx };
}

export class ColonyPlanner {
  blueprints: Blueprint[] = [];
  nextId = 1;
  private accum = 0;
  completed = 0;

  completedByKind: Record<string, number> = {};
  private claimedBy: Int32Array | null = null;
  private claimedW = 0;

  // Reachable-from-spawn mask. The planner only emits blueprints whose
  // cavity is adjacent to a walkable tile reachable from spawn — otherwise
  // dwarves end up with blueprints in disconnected caverns they can't path
  // to. Recomputed lazily when walkable space changes.
  private reachable: Uint8Array | null = null;
  private reachableW = 0;
  private reachableDirty = true;

  /** Run one planning step. Called from sim.tick BEFORE job assignment. */
  tick(ctx: PlannerContext): void {
    this.accum++;
    this.harvestCompleted(ctx.grid);

    if (this.accum < PLAN_INTERVAL_TICKS) return;
    this.accum = 0;

    while (this.activeCount() < MAX_ACTIVE_BLUEPRINTS) {
      if (!this.tryPlaceNext(ctx)) break;
    }
  }

  /**
   * Try to emit one new blueprint, in priority order. Returns true if a
   * blueprint was placed; false if nothing fit. The dispatch logic interleaves
   * infrastructure (rooms) with exploration (corridors, mines) so the colony
   * keeps growing outward instead of stalling once the spawn cavern is full.
   */
  private tryPlaceNext(ctx: PlannerContext): boolean {
    const active = this.activeByKind();

    // 1. Mine — if ore is sensed and reachable, harvest it. High priority so
    //    the colony pursues minerals as soon as a corridor exposes them.
    if ((active["mine"] ?? 0) === 0 && this.placeMine(ctx)) return true;

    // 2. Dining hall and stockpile — emit once at population thresholds.
    if (this.needsDiningHall(ctx) && this.placeRoom(ctx, "dining_hall")) return true;
    if (this.needsStockpile(ctx) && this.placeRoom(ctx, "stockpile")) return true;

    // 3. Periodic corridor — every two completed rooms the colony wants
    //    another corridor segment so its reach keeps growing. This is what
    //    turns "a cluster of rooms around spawn" into "a network of tunnels".
    if (this.wantsExplorationCorridor() && this.placeCorridor(ctx)) return true;

    // 4. Bedrooms — fill up to population target.
    if (this.needsBedroom(ctx) && this.placeRoom(ctx, "bedroom")) return true;

    // 5. Fallback corridor — when nothing else fit, dig outward. Critical:
    //    without this the planner stops cold once the immediate neighborhood
    //    is full of rooms, and the dwarves go idle.
    if ((active["corridor"] ?? 0) === 0 && this.placeCorridor(ctx)) return true;

    return false;
  }

  // ---- Dispatch predicates -----------------------------------------------

  private needsDiningHall(ctx: PlannerContext): boolean {
    if (ctx.population < 4) return false;
    return this.totalOfKind("dining_hall") === 0;
  }

  private needsStockpile(ctx: PlannerContext): boolean {
    if (ctx.population < 5) return false;
    return this.totalOfKind("stockpile") === 0;
  }

  private needsBedroom(ctx: PlannerContext): boolean {
    const target = Math.max(2, Math.ceil(Math.max(1, ctx.population) * 1.5));
    return this.totalOfKind("bedroom") < target;
  }

  /**
   * True if the planner wants to dig another exploration corridor right now.
   * Tied to *completed* rooms (not just active emissions) so the colony
   * actually finishes some infrastructure before chasing tunnels — otherwise
   * the very first hour produces a corridor before any room exists.
   */
  private wantsExplorationCorridor(): boolean {
    if ((this.activeByKind()["corridor"] ?? 0) > 0) return false;
    const corridorTotal = this.totalOfKind("corridor");
    const completedRooms =
      (this.completedByKind["bedroom"] ?? 0) +
      (this.completedByKind["dining_hall"] ?? 0) +
      (this.completedByKind["stockpile"] ?? 0) +
      (this.completedByKind["mine"] ?? 0);
    const corridorTarget = Math.floor(completedRooms / 2);
    return corridorTotal < corridorTarget;
  }

  // ---- Room placement (rectangles adjacent to walkable) ------------------

  private placeRoom(ctx: PlannerContext, kind: BlueprintKind): Blueprint | null {
    const dims = ROOM_DIMS[kind];
    const { spawn } = ctx;
    let best: { x: number; y: number; score: number } | null = null;

    const xBias = (DEFAULT_STYLE as unknown as Record<string, number>)[kind] ?? 0;

    for (let dy = -ROOM_SEARCH_RADIUS; dy <= ROOM_SEARCH_RADIUS; dy++) {
      for (let dx = -ROOM_SEARCH_RADIUS; dx <= ROOM_SEARCH_RADIUS; dx++) {
        const ox = spawn.x + dx;
        const oy = spawn.y + dy;
        if (!this.candidateValid(ctx, ox, oy, dims.w, dims.h)) continue;
        const score = this.scoreRoomCandidate(dx, dy, xBias);
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
    return this.commitBlueprint(ctx, kind, best.x, best.y, dims.w, dims.h, rectCavity(best.x, best.y, dims.w, dims.h));
  }

  private scoreRoomCandidate(dx: number, dy: number, xBias: number): number {
    const distSq = dx * dx + dy * dy;
    let score = -distSq;
    if (dy > 0) score += 40;
    if (dy < -2) score -= 40;
    if (xBias !== 0) score += xBias * dx * 2;
    return score;
  }

  // ---- Corridor placement (1-wide tunnels extending outward) -------------

  /**
   * Place a 1-tile-wide corridor whose first cell is adjacent to walkable
   * space and which extends CORRIDOR_MIN_LEN..CORRIDOR_MAX_LEN tiles in a
   * cardinal direction (preferring downward). Scoring blends direction
   * preference, length achieved, and distance from spawn.
   */
  private placeCorridor(ctx: PlannerContext): Blueprint | null {
    const { grid, spawn, rng } = ctx;
    // Per-emission variation. 30% chance of a 2-wide artery; otherwise 1.
    const wantWidth = rng.nextFloat() < 0.3 ? 2 : 1;
    const wantMaxLen = CORRIDOR_MIN_LEN + rng.nextRange(0, CORRIDOR_MAX_LEN - CORRIDOR_MIN_LEN + 1);

    interface Candidate {
      startX: number;
      startY: number;
      perpDx: number;
      perpDy: number;
      len: number;
      dx: number;
      dy: number;
      width: number;
      score: number;
    }
    const candidates: Candidate[] = [];

    for (let wy = -CORRIDOR_SEARCH_RADIUS; wy <= CORRIDOR_SEARCH_RADIUS; wy++) {
      for (let wx = -CORRIDOR_SEARCH_RADIUS; wx <= CORRIDOR_SEARCH_RADIUS; wx++) {
        const ax = spawn.x + wx;
        const ay = spawn.y + wy;
        if (!grid.isWalkable(ax, ay)) continue;
        // The corridor must start from a walkable tile actually reachable
        // from the spawn — otherwise we'd dig tunnels in disconnected
        // worldgen caverns the dwarves can never visit.
        if (!this.isReachable(ctx, ax, ay)) continue;
        for (const dir of CORRIDOR_DIRS) {
          // Try the desired width first; if 2-wide doesn't fit, fall back
          // to 1 (so we don't lose all candidates when wantWidth=2).
          const widths = wantWidth === 2 ? [2, 1] : [1];
          for (const tryWidth of widths) {
            const perp = perpendicularOf(dir.dx, dir.dy);
            const m = this.measureCorridor(grid, ax, ay, dir.dx, dir.dy, perp.dx, perp.dy, tryWidth, wantMaxLen);
            if (m.len < CORRIDOR_MIN_LEN) continue;
            const exitY = ay + dir.dy * m.len;
            const depthBonus = Math.max(0, exitY - spawn.y) * 4;
            const distSq = wx * wx + wy * wy;
            const widthBonus = tryWidth === 2 ? 30 : 0;
            const score = dir.pref + m.len * 5 - distSq * 0.1 + depthBonus + widthBonus;
            candidates.push({
              startX: m.startX,
              startY: m.startY,
              perpDx: perp.dx,
              perpDy: perp.dy,
              len: m.len,
              dx: dir.dx,
              dy: dir.dy,
              width: tryWidth,
              score,
            });
            break; // accept the widest fit for this (position, direction)
          }
        }
      }
    }

    if (candidates.length === 0) return null;

    // Direction sampling: pick from the top-K weighted by rank. Pure argmax
    // would always emit identical-shape corridors. Mixing in the runners-up
    // is what makes the network feel like a network.
    candidates.sort((a, b) =>
      b.score - a.score ||
      a.startY - b.startY ||
      a.startX - b.startX,
    );
    const topK = Math.min(4, candidates.length);
    const top = candidates.slice(0, topK);
    const weights = top.map((_, i) => Math.pow(0.55, i));
    const totalW = weights.reduce((s, w) => s + w, 0);
    const r = rng.nextFloat() * totalW;
    let acc = 0;
    let chosen = top[0];
    for (let i = 0; i < top.length; i++) {
      acc += weights[i];
      if (r < acc) {
        chosen = top[i];
        break;
      }
    }

    // Build cavity for a width × len strip in (dx, dy) starting at the
    // first solid tile out from the seed; the perpendicular axis covers
    // `width` tiles.
    const cavity = new Int32Array(chosen.len * chosen.width);
    let idx = 0;
    let minX = chosen.startX, maxX = chosen.startX, minY = chosen.startY, maxY = chosen.startY;
    for (let k = 0; k < chosen.len; k++) {
      for (let p = 0; p < chosen.width; p++) {
        const tx = chosen.startX + chosen.dx * k + chosen.perpDx * p;
        const ty = chosen.startY + chosen.dy * k + chosen.perpDy * p;
        cavity[idx++] = (ty << 16) | tx;
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
    }
    return this.commitBlueprint(
      ctx,
      "corridor",
      minX,
      minY,
      maxX - minX + 1,
      maxY - minY + 1,
      cavity,
    );
  }

  /**
   * Walk in (dx, dy) from (ax, ay) up to maxLen steps; at each step verify a
   * `width`-wide perpendicular slab is solid + unclaimed. Returns the
   * largest achievable length and the start cell of the corridor (one step
   * out from the walkable seed).
   */
  private measureCorridor(
    grid: TileGrid,
    ax: number,
    ay: number,
    dx: number,
    dy: number,
    perpDx: number,
    perpDy: number,
    width: number,
    maxLen: number,
  ): { startX: number; startY: number; len: number } {
    const startX = ax + dx;
    const startY = ay + dy;
    let len = 0;
    for (let k = 1; k <= maxLen; k++) {
      let slabOk = true;
      for (let p = 0; p < width && slabOk; p++) {
        const tx = ax + dx * k + perpDx * p;
        const ty = ay + dy * k + perpDy * p;
        if (!grid.inBounds(tx, ty)) { slabOk = false; break; }
        if (!grid.isSolid(tx, ty)) { slabOk = false; break; }
        if (this.isClaimed(grid, tx, ty)) { slabOk = false; break; }
      }
      if (!slabOk) break;
      len++;
    }
    return { startX, startY, len };
  }

  // ---- Mine placement (cavities targeting ore veins) ---------------------

  /**
   * Find an Ore tile within ORE_SENSE_RADIUS of any walkable tile, then
   * place a 3×3 cavity that includes the ore and is itself adjacent to
   * walkable. Returns null if no valid placement exists yet — usually the
   * planner will then emit a corridor toward the nearest ore vein on a
   * later evaluation, exposing more candidates.
   */
  private placeMine(ctx: PlannerContext): Blueprint | null {
    const { grid } = ctx;
    const { w: mw, h: mh } = ROOM_DIMS["mine"];

    let bestOre: { x: number; y: number; score: number } | null = null;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.getTile(x, y) !== TileType.Ore) continue;
        if (this.isClaimed(grid, x, y)) continue;
        if (!this.tileNearReachable(ctx, x, y, ORE_SENSE_RADIUS)) continue;
        const dx = x - ctx.spawn.x;
        const dy = y - ctx.spawn.y;
        const score = -(dx * dx + dy * dy) + (dy > 0 ? 30 : 0);
        if (
          !bestOre ||
          score > bestOre.score ||
          (score === bestOre.score && (y < bestOre.y || (y === bestOre.y && x < bestOre.x)))
        ) {
          bestOre = { x, y, score };
        }
      }
    }
    if (!bestOre) return null;

    // Slide the 3×3 origin around the ore tile until candidateValid passes.
    for (let oyOff = -1; oyOff <= 1; oyOff++) {
      for (let oxOff = -1; oxOff <= 1; oxOff++) {
        const ox = bestOre.x - 1 - oxOff;
        const oy = bestOre.y - 1 - oyOff;
        if (bestOre.x < ox || bestOre.x >= ox + mw) continue;
        if (bestOre.y < oy || bestOre.y >= oy + mh) continue;
        if (!this.candidateValid(ctx, ox, oy, mw, mh)) continue;
        return this.commitBlueprint(ctx, "mine", ox, oy, mw, mh, rectCavity(ox, oy, mw, mh));
      }
    }
    return null;
  }

  /** True if there's a reachable walkable tile within `radius` of (x, y). */
  private tileNearReachable(ctx: PlannerContext, x: number, y: number, radius: number): boolean {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (this.isReachable(ctx, x + dx, y + dy)) return true;
      }
    }
    return false;
  }

  // ---- Common ------------------------------------------------------------

  /**
   * Common emit path: register the blueprint, mark claimed tiles, paint the
   * designation overlay so the renderer can show the planner's intent.
   */
  private commitBlueprint(
    ctx: PlannerContext,
    kind: BlueprintKind,
    originX: number,
    originY: number,
    width: number,
    height: number,
    cavity: Int32Array,
  ): Blueprint {
    const dims = ROOM_DIMS[kind];
    const bp: Blueprint = {
      id: this.nextId++,
      kind,
      originX,
      originY,
      width,
      height,
      cavity,
      status: "digging",
      priority: dims.priority,
      createdTick: ctx.tick,
    };
    this.blueprints.push(bp);
    this.markClaimed(ctx.grid, bp);
    this.markDesignations(ctx.grid, bp, true);
    return bp;
  }

  private candidateValid(ctx: PlannerContext, ox: number, oy: number, w: number, h: number): boolean {
    const grid = ctx.grid;
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        if (!grid.inBounds(x, y)) return false;
        if (!grid.isSolid(x, y)) return false;
        if (this.isClaimed(grid, x, y)) return false;
      }
    }
    // The cavity must touch a walkable tile that is itself reachable from
    // spawn — otherwise we'd be designating a cavity in a disconnected
    // worldgen cavern that the dwarves can never path to.
    let touchesReachable = false;
    for (let y = oy - 1; y <= oy + h && !touchesReachable; y++) {
      for (let x = ox - 1; x <= ox + w && !touchesReachable; x++) {
        if (!grid.inBounds(x, y)) continue;
        if (x >= ox && x < ox + w && y >= oy && y < oy + h) continue;
        if (this.isReachable(ctx, x, y)) touchesReachable = true;
      }
    }
    return touchesReachable;
  }

  // ---- Reachable-from-spawn flood fill -----------------------------------

  /** True if (x, y) is walkable AND connected to spawn via walkable tiles. */
  private isReachable(ctx: PlannerContext, x: number, y: number): boolean {
    if (!ctx.grid.inBounds(x, y)) return false;
    const r = this.ensureReachable(ctx);
    return r[y * ctx.grid.width + x] === 1;
  }

  private ensureReachable(ctx: PlannerContext): Uint8Array {
    const grid = ctx.grid;
    if (
      !this.reachable ||
      this.reachableW !== grid.width ||
      this.reachable.length !== grid.width * grid.height
    ) {
      this.reachable = new Uint8Array(grid.width * grid.height);
      this.reachableW = grid.width;
      this.reachableDirty = true;
    }
    if (!this.reachableDirty) return this.reachable;
    this.reachable.fill(0);
    if (!grid.isWalkable(ctx.spawn.x, ctx.spawn.y)) {
      // Spawn somehow not walkable — leave mask empty (no candidates valid).
      this.reachableDirty = false;
      return this.reachable;
    }
    const w = grid.width;
    const queue = new Int32Array(grid.width * grid.height);
    let head = 0;
    let tail = 0;
    const startIdx = ctx.spawn.y * w + ctx.spawn.x;
    queue[tail++] = startIdx;
    this.reachable[startIdx] = 1;
    while (head < tail) {
      const idx = queue[head++];
      const cx = idx % w;
      const cy = (idx / w) | 0;
      // 4-connected; pathing is 8-connected but the reachable check is
      // conservative. A 4-connected flood-fill is a subset of 8-connected
      // reachability — every 4-reachable tile is also 8-reachable.
      for (const [dx, dy] of REACH_DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
        if (!grid.isWalkable(nx, ny)) continue;
        const nidx = ny * w + nx;
        if (this.reachable[nidx]) continue;
        this.reachable[nidx] = 1;
        queue[tail++] = nidx;
      }
    }
    this.reachableDirty = false;
    return this.reachable;
  }

  // ---- Inspection / counts -----------------------------------------------

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

  private totalOfKind(kind: BlueprintKind): number {
    return (this.completedByKind[kind] ?? 0) + (this.activeByKind()[kind] ?? 0);
  }

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
    // Walkable area changes whenever a tile gets mined, not just when a
    // blueprint fully completes — partial digs in long corridors expand the
    // reachable set too. Just invalidate every tick; the rebuild is only
    // actually run on demand in the next planner evaluation (hourly).
    this.reachableDirty = true;
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

  rehydrate(grid: TileGrid): void {
    this.claimedBy = null;
    this.ensureClaimedIndex(grid);
    this.completedByKind = {};
    for (const b of this.blueprints) {
      if (b.status === "complete") {
        this.completedByKind[b.kind] = (this.completedByKind[b.kind] ?? 0) + 1;
      }
      if (b.status === "digging") this.markDesignations(grid, b, true);
    }
  }

  buildSummary(): { kind: BlueprintKind; active: number; complete: number }[] {
    const kinds: BlueprintKind[] = ["bedroom", "dining_hall", "stockpile", "corridor", "mine", "stairwell"];
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
