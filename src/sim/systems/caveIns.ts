// Cave-ins (GDD crises: "cave-ins"). A natural hazard of over-wide,
// unsupported excavation.
//
// Trigger rule
// ------------
// Every time a tile is mined out, the mining path queues the cell
// (noteTileMined). caveInSystem resolves the queue later the same tick
// — after the work loop has finished iterating dwarves, so a collapse
// can kill dwarves without mutating a sparse set mid-iteration. The
// queue never survives a tick, so there is nothing to save. Clearing
// cave-in rubble doesn't queue a check — digging out a collapse is
// shoring it up, not opening new ground.
//
// For each queued cell we measure the *unsupported ceiling span* of the
// chamber it opened into:
//   1. walk up from the mined cell through open tiles to the first solid
//      tile — that's the ceiling (no ceiling within CEILING_SCAN tiles →
//      open to a cavern / the sky, no risk);
//   2. a column counts as part of the span when its ceiling tile is
//      solid AND it has at least two open tiles beneath the ceiling.
//      One-tall tunnels are self-supporting (their walls are the
//      pillars), which keeps the planner's long corridors safe;
//   3. extend left/right from the mined column while columns qualify.
// Spans up to SAFE_SPAN tiles never collapse. SAFE_SPAN equals the
// widest room the Colony Planner digs (the 8-wide dining hall), so a
// planner room on its own is safe by construction — great halls (6)
// and throne rooms (5) included. Risk comes from cavities that merge
// into something nobody designed: rooms dug shoulder-to-shoulder, a
// mine breaking through into a neighbouring room, digs that open onto
// a wide natural cavern ceiling.
//
// Each tile beyond SAFE_SPAN adds BASE_CHANCE_PER_TILE to the per-dig
// collapse chance, scaled by how soft the ceiling rock is (dirt and
// sand crumble; granite and the deep metals barely do) and by research
// (Masonry & Mortaring / Fortification Design each halve it), capped
// at MAX_CHANCE. The roll is a stateless hash of (seed, cell, tick) so
// it never shifts the aiRng / worldRng streams other systems rely on.
//
// Collapse
// --------
// A 3–5 cell stretch of the chamber's top row, centred on the mined
// column, refills with Rubble. Only plain floor cells inside planner
// blueprints are filled (never furniture / doors / memorials, and never
// the span's end cells, where corridors and stairwells join), and only
// cells with an open tile beneath — so the row below stays passable
// and a collapse can't seal anyone in. Rubble is solid rock sitting in
// a blueprint cavity, so the miners clear it the next time the colony
// is digging. Loose items on a filled cell drop to the open floor
// beneath; cells holding hostiles or pets are left alone.
//
// A dwarf standing under the falling stretch is struck for 30–110% of
// max HP: usually a severe wound, fatal for roughly one healthy dwarf
// in eight and far likelier for one already hurt (killDwarf "crushed
// in a cave-in"). Their own cell stays open — survivors are dug free,
// the dead are recovered and get their Memorial — so nobody is ever
// left embedded in rock.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { TileType } from "../world/tiles";
import { BLUEPRINT_KIND_LABELS } from "../planner/blueprint";
import { dropJob, killDwarf } from "./shared";

/** Widest unsupported span (tiles) that never collapses. */
export const CAVE_IN_SAFE_SPAN = 8;
/** Per-dig collapse chance added for each tile of span beyond SAFE_SPAN
 * (before softness / research scaling). */
export const CAVE_IN_BASE_CHANCE_PER_TILE = 0.01;
/** Upper bound on the per-dig collapse chance. */
export const CAVE_IN_MAX_CHANCE = 0.15;
/** How far up from the mined cell we look for a ceiling. */
const CEILING_SCAN = 8;
/** Cap on how far the span measurement walks sideways. */
const SPAN_SCAN = 48;
/** Research topics that each halve the collapse chance. */
const SUPPORT_RESEARCH = ["masonry_and_mortaring", "fortification_design"];
const SEVERE_WOUND_RATIO = 0.3;

/** How readily the ceiling material gives way. */
function softness(tile: number): number {
  switch (tile) {
    case TileType.Dirt:
    case TileType.Sand:
    case TileType.Rubble:
      return 3;
    case TileType.Aquifer:
      return 2;
    case TileType.Stone:
    case TileType.Coal:
    case TileType.Ore:
    case TileType.CaveMushroom:
      return 1;
    case TileType.Granite:
    case TileType.Silver:
    case TileType.Gold:
      return 0.5;
    default:
      return 0.3;
  }
}

const pending = new WeakMap<SimWorld, number[]>();

/** Called from the mining path when a tile has just been mined out. */
export function noteTileMined(sim: SimWorld, x: number, y: number): void {
  let q = pending.get(sim);
  if (!q) {
    q = [];
    pending.set(sim, q);
  }
  q.push((y << 16) | x);
}

/** Stateless deterministic 32-bit hash (no shared RNG stream consumed). */
function hash4(a: number, b: number, c: number, d: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ c, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ d, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 16;
  return h >>> 0;
}

function unit(h: number): number {
  return h / 0x100000000;
}

export interface CeilingSpan {
  /** y of the solid ceiling tile. */
  ceilY: number;
  /** Leftmost / rightmost qualifying column (inclusive). */
  left: number;
  right: number;
  span: number;
}

/** Measure the unsupported ceiling span above an open cell. Returns
 * null when the cell's column has no ceiling within reach or the
 * chamber is only one tile tall there. */
export function measureCeilingSpan(sim: SimWorld, x: number, y: number): CeilingSpan | null {
  const grid = sim.grid;
  if (grid.isSolid(x, y)) return null;
  let ceilY = -1;
  for (let yy = y - 1, n = 0; yy >= 0 && n < CEILING_SCAN; yy--, n++) {
    if (grid.isSolid(x, yy)) {
      ceilY = yy;
      break;
    }
  }
  if (ceilY < 0) return null;
  const top = ceilY + 1;
  const qualifies = (cx: number): boolean =>
    grid.inBounds(cx, top + 1) &&
    grid.isSolid(cx, ceilY) &&
    !grid.isSolid(cx, top) &&
    !grid.isSolid(cx, top + 1);
  if (!qualifies(x)) return null;
  let left = x;
  let right = x;
  while (x - left < SPAN_SCAN && qualifies(left - 1)) left--;
  while (right - x < SPAN_SCAN && qualifies(right + 1)) right++;
  return { ceilY, left, right, span: right - left + 1 };
}

/** Per-dig collapse chance for a measured span. */
export function caveInChance(sim: SimWorld, x: number, s: CeilingSpan): number {
  if (s.span <= CAVE_IN_SAFE_SPAN) return 0;
  let p = CAVE_IN_BASE_CHANCE_PER_TILE * (s.span - CAVE_IN_SAFE_SPAN);
  p *= softness(sim.grid.getTile(x, s.ceilY));
  const done = sim.research.completed;
  for (const topic of SUPPORT_RESEARCH) if (done.includes(topic)) p *= 0.5;
  return Math.min(CAVE_IN_MAX_CHANCE, p);
}

export function caveInSystem(sim: SimWorld): void {
  const q = pending.get(sim);
  if (!q || q.length === 0) return;
  const cells = q.splice(0, q.length);
  for (const c of cells) {
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    const s = measureCeilingSpan(sim, x, y);
    if (!s) continue;
    const p = caveInChance(sim, x, s);
    if (p <= 0) continue;
    const h = hash4(sim.seed, x, y, sim.tick);
    if (unit(h) >= p) continue;
    collapse(sim, x, s, h);
  }
}

function placeName(sim: SimWorld, x: number, y: number): string {
  for (const b of sim.planner.blueprints) {
    if (x < b.originX || y < b.originY || x >= b.originX + b.width || y >= b.originY + b.height) continue;
    for (let i = 0; i < b.cavity.length; i++) {
      if (b.cavity[i] === ((y << 16) | x)) {
        const label = BLUEPRINT_KIND_LABELS[b.kind];
        return b.kind === "corridor" || b.kind === "mine" ? `a ${label.toLowerCase()}` : `the ${label}`;
      }
    }
  }
  return "a tunnel";
}

function depthPhrase(y: number, spawnY: number): string {
  const d = y - spawnY;
  if (d < 20) return "in the upper halls";
  if (d < 60) return "in the shallow earth";
  if (d < 150) return "deep beneath the entrance";
  return "in the deep rock";
}

/** Bring down part of the ceiling over column `x`. Exported for tests. */
export function collapse(sim: SimWorld, x: number, s: CeilingSpan, h: number): number {
  const grid = sim.grid;
  const top = s.ceilY + 1;
  const radius = 1 + ((h >>> 8) & 1); // 3 or 5 cells wide
  // Never fill the span's end cells — that's where corridors and
  // stairwells join the chamber.
  const lo = Math.max(s.left + 1, x - radius);
  const hi = Math.min(s.right - 1, x + radius);
  if (hi < lo) return 0;

  // Bucket whatever stands in the falling stretch: dwarves are struck,
  // items are knocked down, anything else (hostiles, pets) spares its
  // cell.
  const occupied = new Set<number>();
  const dwarfAt = new Map<number, EntityId[]>();
  const itemsAt = new Map<number, EntityId[]>();
  const ents = sim.position.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const p = sim.position.get(e);
    if (!p || p.y !== top || p.x < lo || p.x > hi) continue;
    const key = p.x;
    const bucket = sim.dwarf.has(e) ? dwarfAt : sim.item.has(e) ? itemsAt : null;
    if (bucket) {
      const arr = bucket.get(key) ?? [];
      arr.push(e);
      bucket.set(key, arr);
    } else {
      occupied.add(key);
    }
  }

  const filled: number[] = [];
  const victims: { e: EntityId; killed: boolean }[] = [];
  for (let cx = lo; cx <= hi; cx++) {
    const t = grid.getTile(cx, top);
    if (t !== TileType.CorridorFloor && t !== TileType.CavernFloor) continue;
    if (grid.isSolid(cx, top + 1)) continue;
    if (!sim.planner.containsTile(grid, cx, top)) continue;
    if (occupied.has(cx)) continue;
    const here = dwarfAt.get(cx);
    if (here) {
      // The rock comes down on whoever is standing here. Their cell
      // stays open — survivors are dug free, the dead are recovered
      // (and get their Memorial) — so no one is ever left inside rock.
      for (const e of here) {
        const hp = sim.health.get(e);
        const roll = unit(hash4(h, e, cx, 0x5eed));
        const dmg = hp ? Math.round(hp.maxHp * (0.3 + roll * 0.8)) : Infinity;
        const killed = !hp || dmg >= hp.hp;
        victims.push({ e, killed });
        if (!killed) {
          hp!.hp -= dmg;
          if (hp!.hp <= hp!.maxHp * SEVERE_WOUND_RATIO) hp!.wasSevereWound = true;
        }
      }
      continue;
    }
    filled.push(cx);
  }
  if (filled.length === 0 && victims.length === 0) return 0;

  const where = placeName(sim, x, top);
  const depth = depthPhrase(top, sim.spawn.y);
  sim.events.add(
    sim.tick,
    "crisis",
    filled.length > 0
      ? `Cave-in! The ceiling of ${where} gives way ${depth}, burying ${filled.length} tile${filled.length === 1 ? "" : "s"} in rubble.`
      : `Cave-in! Rock shears from the ceiling of ${where} ${depth}.`,
    { x, y: top },
  );

  for (const cx of filled) {
    grid.setTile(cx, top, TileType.Rubble);
    grid.setDesignation(cx, top, 0);
    // Loose items on the cell are knocked down onto the open floor
    // beneath (always open — see the fill rule above).
    for (const it of itemsAt.get(cx) ?? []) {
      const p = sim.position.get(it);
      if (p) p.y = top + 1;
    }
  }
  // Survivors' wounds first (they're still alive), then the dead.
  for (const v of victims) {
    if (v.killed) continue;
    const dw = sim.dwarf.get(v.e);
    if (dw) {
      const p = sim.position.get(v.e);
      sim.events.add(sim.tick, "crisis", `${dw.name} is pinned by falling rock and dragged out badly hurt.`, p ? { x: p.x, y: p.y } : undefined);
    }
    dropJob(sim, v.e);
  }
  for (const v of victims) {
    if (v.killed && sim.ecs.isAlive(v.e)) killDwarf(sim, v.e, "crushed in a cave-in");
  }
  if (filled.length > 0) {
    sim.regions.invalidate();
    // Any job aimed at a now-filled cell (hauls to it, maintenance,
    // sleeping, ...) is void. Mine jobs target solid rock and are
    // unaffected; their claims stay on solid tiles.
    const filledSet = new Set(filled);
    const dw = sim.dwarf.entities.slice();
    for (const e of dw) {
      const job = sim.job.get(e);
      if (!job || job.kind === "mine") continue;
      if (job.targetY === top && filledSet.has(job.targetX)) dropJob(sim, e);
    }
  }
  return filled.length;
}
