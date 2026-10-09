// Siege warbands hunt (GDD §4.3 / §9). A siege warband with nobody in
// pursuit range doesn't idle at the gate until it gives up: it follows
// a distance field that spreads out from every dwarf, so hiding deep in
// a Safe Zone buys time rather than safety. Lockdown seals count as
// passable in the field — the warband walks up to a sealed entrance and
// batters it, and a seal that takes enough blows breaks open (GDD:
// "doors have HP; fortified stone doors last longest").

import { SimWorld } from "../world/simWorld";
import { TileType } from "../world/tiles";

/** Recompute the hunt field this often (a goblin steps every 22 ticks). */
const FIELD_INTERVAL_TICKS = 22;
/** Blows a sealed entrance tile takes before it breaks. With two or
 * three goblins hammering one shaft (one blow each per step, every 22
 * ticks) that is roughly an in-game day. */
export const SEAL_HP = 150;
/** Fortification Design (Tier 3): gates designed to be held. */
export const FORTIFIED_SEAL_HP = 300;

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

interface HuntField {
  tick: number;
  dist: Int32Array;
}

const fields = new WeakMap<SimWorld, HuntField>();

function sealHp(sim: SimWorld): number {
  return sim.research.completed.includes("fortification_design") ? FORTIFIED_SEAL_HP : SEAL_HP;
}

/** Index into emergency.sealed (triple index) for a tile, or -1. */
function sealIndexAt(sim: SimWorld, x: number, y: number): number {
  const sealed = sim.emergency.sealed;
  if (!sealed) return -1;
  for (let i = 0; i + 2 < sealed.length; i += 3) {
    if (sealed[i] === x && sealed[i + 1] === y) return i / 3;
  }
  return -1;
}

function isSealedTile(sim: SimWorld, x: number, y: number): boolean {
  return sim.grid.getTile(x, y) === TileType.DoorBarred && sealIndexAt(sim, x, y) !== -1;
}

/** Breadth-first distance (in steps) from the nearest dwarf, through
 * walkable tiles and Lockdown seals. -1 = unreachable. Cached per
 * FIELD_INTERVAL_TICKS. */
function huntField(sim: SimWorld): Int32Array {
  const cached = fields.get(sim);
  if (cached && sim.tick - cached.tick < FIELD_INTERVAL_TICKS) return cached.dist;
  const g = sim.grid;
  const w = g.width;
  const dist = cached?.dist ?? new Int32Array(w * g.height);
  dist.fill(-1);
  const queue: number[] = [];
  sim.forEachDwarf((_id, p) => {
    const i = p.y * w + p.x;
    if (dist[i] === -1) {
      dist[i] = 0;
      queue.push(i);
    }
  });
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % w;
    const y = (i / w) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (!g.inBounds(nx, ny)) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== -1) continue;
      if (!g.isWalkable(nx, ny) && !isSealedTile(sim, nx, ny)) continue;
      dist[ni] = dist[i] + 1;
      queue.push(ni);
    }
  }
  fields.set(sim, { tick: sim.tick, dist });
  return dist;
}

/** Advance a siege goblin one step toward the nearest dwarf. Returns
 * true if it acted (moved or struck a seal). */
export function siegeHuntStep(sim: SimWorld, pos: { x: number; y: number }): boolean {
  const g = sim.grid;
  const w = g.width;
  const dist = huntField(sim);
  const here = dist[pos.y * w + pos.x];
  let bestX = -1;
  let bestY = -1;
  let bestD = here === -1 ? Infinity : here;
  for (let k = 0; k < 4; k++) {
    const nx = pos.x + DX[k];
    const ny = pos.y + DY[k];
    if (!g.inBounds(nx, ny)) continue;
    const d = dist[ny * w + nx];
    if (d === -1 || d >= bestD) continue;
    bestD = d;
    bestX = nx;
    bestY = ny;
  }
  if (bestX === -1) return false;
  if (isSealedTile(sim, bestX, bestY)) {
    batterSeal(sim, bestX, bestY);
    return true;
  }
  pos.x = bestX;
  pos.y = bestY;
  return true;
}

/** One blow against a sealed entrance tile; breaks it at sealHp. */
function batterSeal(sim: SimWorld, x: number, y: number): void {
  const e = sim.emergency;
  const idx = sealIndexAt(sim, x, y);
  if (idx === -1 || !e.sealed) return;
  const damage = (e.sealDamage ??= []);
  damage[idx] = (damage[idx] ?? 0) + 1;
  if (damage[idx] < sealHp(sim)) return;
  // Broken: restore the original tile and drop it from the seal list.
  sim.grid.setTile(x, y, e.sealed[idx * 3 + 2]);
  e.sealed.splice(idx * 3, 3);
  damage.splice(idx, 1);
  sim.regions.invalidate();
  fields.delete(sim);
  sim.events.add(
    sim.tick,
    "crisis",
    "The warband has battered through a sealed entrance. The goblins are inside!",
    { x, y },
  );
}
