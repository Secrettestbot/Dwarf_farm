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
import { EventLog } from "../events/eventLog";
import { narrateBlueprintBegin, narrateBlueprintComplete } from "../events/narrator";
import { Blueprint, BlueprintKind, isComplete, isRoomNeglected, rectCavity } from "./blueprint";
import { furnishRoom } from "./furnish";

export interface PlannerContext {
  grid: TileGrid;
  spawn: { x: number; y: number };
  tick: number;
  /** Live colony population — drives how aggressively the planner expands. */
  population: number;
  /** Forked, deterministic RNG used to vary placement (corridor length,
   * width, direction sampling). State is part of SimWorld and serialized. */
  rng: Rng;
  /** Optional event log — when present, the planner narrates blueprint
   * lifecycle events ("plans laid out", "tunnel complete", etc.). The log
   * is part of save state, so the chronicle is reproducible. */
  events?: EventLog;
}

const PLAN_INTERVAL_TICKS = 60; // re-evaluate once per in-game hour

const ROOM_DIMS: Record<BlueprintKind, { w: number; h: number; priority: number }> = {
  bedroom: { w: 4, h: 3, priority: 1 },
  dining_hall: { w: 8, h: 5, priority: 3 },
  stockpile: { w: 5, h: 4, priority: 2 },
  // Corridors are placed by a custom routine; this dim entry just holds the
  // per-segment metadata used by the renderer / blueprint commit path.
  corridor: { w: 8, h: 1, priority: 4 },
  // Mines are 2×2 chambers around an ore tile. Smaller than rooms so they
  // can fit between corridors and ore-vein neighbours where larger cavities
  // would be blocked by adjacent walkable tiles.
  mine: { w: 2, h: 2, priority: 2 },
  farm: { w: 4, h: 3, priority: 2 },
  stairwell: { w: 2, h: 6, priority: 5 },
  // Workshops: a small chamber with the workstation in its centre. Big
  // enough that a hauler can squeeze past the crafter, small enough not
  // to bloat the architect's footprint when several workshops drop in.
  kitchen: { w: 3, h: 3, priority: 2 },
  brewery: { w: 3, h: 3, priority: 2 },
  smelter: { w: 3, h: 3, priority: 2 },
  forge: { w: 3, h: 3, priority: 2 },
  // Trade depot: a wider open room near the entrance for caravans to
  // park. Placed once per colony at moderate size.
  trade_depot: { w: 5, h: 4, priority: 3 },
  // Library: a quiet 4×3 chamber with two desks. Wider than the
  // workshops so two scholars can fit without colliding.
  library: { w: 4, h: 3, priority: 2 },
};

const CORRIDOR_MIN_LEN = 4;
const CORRIDOR_MAX_LEN = 10;
const ORE_SENSE_RADIUS = 12; // an ore tile is sense-able this many tiles from walkable
/** One architect per ARCHITECT_PER_DWARVES dwarves: a small colony of seven
 * gets one active blueprint at a time, but a larger colony parallelises the
 * work and expands faster. */
const ARCHITECT_PER_DWARVES = 7;

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
    this.harvestCompleted(ctx);

    if (this.accum < PLAN_INTERVAL_TICKS) return;
    this.accum = 0;

    // Architect count scales with population: 1 architect per 7 dwarves,
    // minimum 1. As the colony grows, more parallel blueprints can be
    // active, so growth speeds up.
    const architects = Math.max(1, Math.ceil(ctx.population / ARCHITECT_PER_DWARVES));
    while (this.activeCount() < architects) {
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
    // 2.5 Farm — once population is large enough to need ongoing food
    //     production (founders bring a starter cache that lasts a couple
    //     of in-game months). We aim for at least one farm per ~7 dwarves
    //     so a growing colony stays self-sufficient.
    if (this.needsFarm(ctx) && this.placeRoom(ctx, "farm")) return true;

    // 2.7 Workshops — kitchen, brewery, smelter, forge. Each lands once
    //     the colony is large enough to use it. Kitchen + brewery come
    //     first (food / drink loops directly impact survival); smelter
    //     and forge follow as the colony's mining output grows.
    if (this.needsKitchen(ctx) && this.placeRoom(ctx, "kitchen")) return true;
    if (this.needsBrewery(ctx) && this.placeRoom(ctx, "brewery")) return true;
    if (this.needsSmelter(ctx) && this.placeRoom(ctx, "smelter")) return true;
    if (this.needsForge(ctx) && this.placeRoom(ctx, "forge")) return true;
    if (this.needsTradeDepot(ctx) && this.placeRoom(ctx, "trade_depot")) return true;
    if (this.needsLibrary(ctx) && this.placeRoom(ctx, "library")) return true;

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
    return this.maintainedAndActiveOfKind("dining_hall", ctx.tick) === 0;
  }

  private needsStockpile(ctx: PlannerContext): boolean {
    if (ctx.population < 5) return false;
    return this.maintainedAndActiveOfKind("stockpile", ctx.tick) === 0;
  }

  private needsFarm(ctx: PlannerContext): boolean {
    // First farm at pop ≥ 4; one additional farm per ~7 dwarves. Keeps
    // the colony fed through migration-driven growth.
    if (ctx.population < 4) return false;
    const target = Math.max(1, Math.ceil(ctx.population / 7));
    return this.maintainedAndActiveOfKind("farm", ctx.tick) < target;
  }

  private needsBedroom(ctx: PlannerContext): boolean {
    const target = Math.max(2, Math.ceil(Math.max(1, ctx.population) * 1.5));
    // Only well-maintained bedrooms count toward the target. A neglected
    // bedroom has to be brought back into shape before the architect
    // emits another one — capping the colony's footprint at what its
    // dwarves can actually keep up with.
    return this.maintainedAndActiveOfKind("bedroom", ctx.tick) < target;
  }

  private needsKitchen(ctx: PlannerContext): boolean {
    if (ctx.population < 5) return false;
    return this.maintainedAndActiveOfKind("kitchen", ctx.tick) === 0;
  }

  private needsBrewery(ctx: PlannerContext): boolean {
    if (ctx.population < 5) return false;
    return this.maintainedAndActiveOfKind("brewery", ctx.tick) === 0;
  }

  private needsSmelter(ctx: PlannerContext): boolean {
    // The smelter only matters once there's actually ore to smelt and a
    // population large enough to spare a dedicated smith.
    if (ctx.population < 8) return false;
    return this.maintainedAndActiveOfKind("smelter", ctx.tick) === 0;
  }

  private needsForge(ctx: PlannerContext): boolean {
    // The forge needs the smelter to feed it; gate one tier above.
    if (ctx.population < 10) return false;
    if (this.maintainedAndActiveOfKind("smelter", ctx.tick) === 0) return false;
    return this.maintainedAndActiveOfKind("forge", ctx.tick) === 0;
  }

  private needsTradeDepot(ctx: PlannerContext): boolean {
    // Caravans only show up once the colony is large enough to be worth
    // visiting — and only one depot per fortress.
    if (ctx.population < 6) return false;
    return this.maintainedAndActiveOfKind("trade_depot", ctx.tick) === 0;
  }

  private needsLibrary(ctx: PlannerContext): boolean {
    // The library lands once the colony has the bandwidth to spare a
    // dwarf or two for scholarship — and only one per fortress until
    // the population justifies more research throughput.
    if (ctx.population < 8) return false;
    return this.maintainedAndActiveOfKind("library", ctx.tick) === 0;
  }

  /**
   * Count of completed rooms of `kind` that are not currently neglected,
   * plus any blueprint of that kind still being dug. Used by the
   * needs-X predicates so the architect doesn't expand past the colony's
   * maintenance capacity.
   */
  private maintainedAndActiveOfKind(kind: BlueprintKind, currentTick: number): number {
    let n = 0;
    for (const b of this.blueprints) {
      if (b.kind !== kind) continue;
      if (b.status === "digging") {
        n++;
        continue;
      }
      if (b.status !== "complete") continue;
      if (!isRoomNeglected(b, currentTick)) n++;
    }
    return n;
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
    const { grid } = ctx;
    let best: { x: number; y: number; score: number } | null = null;

    const xBias = (DEFAULT_STYLE as unknown as Record<string, number>)[kind] ?? 0;

    // Iterate every reachable walkable tile and try a placement anchored to
    // each of its four cardinal neighbours. Previously the search was a
    // ±60 box around spawn, which silently capped the colony to the Skin
    // layer — once corridors descended past that radius, no room could
    // land at the bottom of the shaft.
    const reachable = this.ensureReachable(ctx);
    const seen = new Set<number>();
    const w = grid.width;
    const halfW = Math.floor(dims.w / 2);
    const halfH = Math.floor(dims.h / 2);

    for (let i = 0; i < reachable.length; i++) {
      if (reachable[i] !== 1) continue;
      const wx = i % w;
      const wy = (i / w) | 0;
      // Four candidate origins: room extending right of, left of, below, or
      // above the walkable seed tile. Centred on the perpendicular axis so
      // the doorway lines up with where the dwarves are.
      const candidates: Array<[number, number]> = [
        [wx + 1, wy - halfH],         // right
        [wx - dims.w, wy - halfH],    // left
        [wx - halfW, wy + 1],         // below
        [wx - halfW, wy - dims.h],    // above
      ];
      for (const [ox, oy] of candidates) {
        const key = (oy << 16) | (ox & 0xffff);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!this.candidateValid(ctx, ox, oy, dims.w, dims.h)) continue;
        const score = this.scoreRoomCandidate(ox, oy, kind, ctx.spawn, xBias);
        if (
          best === null ||
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

  /**
   * Score a candidate room placement. The previous version used a
   * −dist² penalty against the spawn, which made every bedroom land
   * within spitting distance of the entrance. The new shape:
   *
   *   - Reward depth (+0.4 per tile below spawn, capped) so rooms follow
   *     the colony's descent rather than clustering at the surface.
   *   - Reward spread from the *nearest same-kind* room (capped at 30
   *     tiles distance) — bedrooms scatter, dining halls don't pile up.
   *   - Style bias (the existing left/right pull for dining/stockpile).
   *
   * The result: bedrooms place along the colony's descending shaft, not
   * shoulder-to-shoulder under the entrance.
   */
  private scoreRoomCandidate(
    ox: number,
    oy: number,
    kind: BlueprintKind,
    spawn: { x: number; y: number },
    xBias: number,
  ): number {
    let score = 0;
    // Depth reward: rooms further below the surface score better, with a
    // soft cap so absurdly-deep candidates aren't overweight.
    const depth = oy - spawn.y;
    score += Math.min(80, Math.max(0, depth)) * 0.4;
    if (depth < -2) score -= 40; // discourage placing rooms above the spawn
    // Spread bonus: prefer placement far from existing same-kind rooms.
    let nearest = Infinity;
    for (const b of this.blueprints) {
      if (b.kind !== kind) continue;
      const dx = ox - b.originX;
      const dy = oy - b.originY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearest) nearest = d;
    }
    if (nearest === Infinity) {
      // No same-kind rooms exist yet — neutral spread score.
      score += 30;
    } else {
      score += Math.min(60, nearest);
    }
    // Style bias (left/right pull) — preserved.
    if (xBias !== 0) score += xBias * (ox - spawn.x) * 0.5;
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

    // Collect the BEST candidate per cardinal direction. Selecting one per
    // direction (rather than a flat top-K by score) is what enforces
    // genuine variety: depth bias in the score makes every "down" candidate
    // outrank every lateral one, so a flat top-K samples almost exclusively
    // vertical strips. This way each direction competes only with itself
    // for the best location, then we pick across directions on weighted
    // probability — not score.
    const bestByDir = new Map<string, Candidate>();

    // Iterate every reachable walkable tile. Was previously a ±50 box around
    // spawn, which capped tunnel placement to the upper Skin layer once the
    // colony's deepest walkable tile exceeded that distance.
    const reachable = this.ensureReachable(ctx);
    const gridW = grid.width;
    for (let i = 0; i < reachable.length; i++) {
      if (reachable[i] !== 1) continue;
      const ax = i % gridW;
      const ay = (i / gridW) | 0;
      {
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
            const widthBonus = tryWidth === 2 ? 30 : 0;
            // No distance penalty: corridors *should* reach outward. The
            // squared penalty used previously made the score plateau around
            // 30 tiles from spawn, so the colony stalled before reaching
            // the ore-bearing Shallow Earth layer at y ≥ 80.
            const score = dir.pref + m.len * 5 + depthBonus + widthBonus;
            const cand: Candidate = {
              startX: m.startX,
              startY: m.startY,
              perpDx: perp.dx,
              perpDy: perp.dy,
              len: m.len,
              dx: dir.dx,
              dy: dir.dy,
              width: tryWidth,
              score,
            };
            const key = `${dir.dx},${dir.dy}`;
            const existing = bestByDir.get(key);
            if (
              !existing ||
              cand.score > existing.score ||
              (cand.score === existing.score &&
                (cand.startY < existing.startY ||
                  (cand.startY === existing.startY && cand.startX < existing.startX)))
            ) {
              bestByDir.set(key, cand);
            }
            break; // accept the widest fit for this (position, direction)
          }
        }
      }
    }

    if (bestByDir.size === 0) return null;

    // Pick a direction with fixed weights so each emission has a real
    // chance of going laterally rather than always descending. Up direction
    // gets 0% weight — it's only ever picked as a last resort if no other
    // direction has any valid candidate.
    const dirWeights: Array<{ key: string; weight: number }> = [
      { key: "0,1", weight: 50 },   // down
      { key: "1,0", weight: 25 },   // right
      { key: "-1,0", weight: 25 },  // left
    ];
    const validWeighted = dirWeights.filter((d) => bestByDir.has(d.key));
    let chosen: Candidate | undefined;
    if (validWeighted.length > 0) {
      const totalW = validWeighted.reduce((s, d) => s + d.weight, 0);
      const r = rng.nextFloat() * totalW;
      let acc = 0;
      let pickedKey = validWeighted[0].key;
      for (const d of validWeighted) {
        acc += d.weight;
        if (r < acc) {
          pickedKey = d.key;
          break;
        }
      }
      chosen = bestByDir.get(pickedKey);
    } else {
      // Last resort: try whatever's left (e.g. only up has a valid run).
      const remaining = Array.from(bestByDir.values()).sort((a, b) => b.score - a.score);
      chosen = remaining[0];
    }
    if (!chosen) return null;

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

    // Try every origin where the cavity covers the ore tile. For a 2×2
    // mine that's 4 candidate origins (top-left through bottom-right
    // anchored relative to the ore). The first valid one wins.
    for (let oyOff = 0; oyOff < mh; oyOff++) {
      for (let oxOff = 0; oxOff < mw; oxOff++) {
        const ox = bestOre.x - oxOff;
        const oy = bestOre.y - oyOff;
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
   * designation overlay so the renderer can show the planner's intent, and
   * narrate the new plan in the event log.
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
    if (ctx.events) {
      ctx.events.add(ctx.tick, "construction", narrateBlueprintBegin(ctx.rng, bp, ctx.spawn.y));
    }
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

  /**
   * Read-only accessor for the reachable-from-spawn mask. Used by the
   * hostile spawn system to pick a candidate tile that's connected to the
   * colony but far from any dwarf — without forcing the planner internals
   * to know about hostiles.
   */
  exposeReachable(sim: { grid: TileGrid; spawn: { x: number; y: number } }): Uint8Array | null {
    return this.ensureReachable({
      grid: sim.grid,
      spawn: sim.spawn,
      tick: 0,
      population: 0,
      // ensureReachable reads only grid + spawn; rng/events/tick are unused.
      rng: undefined as unknown as import("../rng").Rng,
    });
  }

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

  private harvestCompleted(ctx: PlannerContext): void {
    const grid = ctx.grid;
    for (const b of this.blueprints) {
      if (b.status === "digging" && isComplete(b, grid)) {
        b.status = "complete";
        this.completed++;
        this.completedByKind[b.kind] = (this.completedByKind[b.kind] ?? 0) + 1;
        // A freshly-dug room counts as fully maintained — the dig itself
        // exercised every cell. The maintenance clock starts now.
        b.lastMaintainedTick = ctx.tick;
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          grid.setDesignation(x, y, 0);
        }
        // The room is dug; now furnish it. Beds in bedrooms, tables in
        // dining halls, bins in stockpiles. Tunnels and mines stay bare.
        furnishRoom(grid, b);
        if (ctx.events) {
          ctx.events.add(ctx.tick, "construction", narrateBlueprintComplete(ctx.rng, b, ctx.spawn.y));
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
