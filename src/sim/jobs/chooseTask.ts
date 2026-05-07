// Decide what an idle dwarf should do next. The hierarchy mirrors GDD §6.2:
// critical needs first, then work, then social, then idle wandering. Every
// branch consults seeded RNG when ties must be broken — never Math.random.

import { SimWorld } from "../world/simWorld";
import { JobAssignment, JobKind } from "../ecs/components";
import { EntityId } from "../ecs/world";
import { findMineTarget } from "./chooseJob";

const SLEEP_CRITICAL = 25;
const SOCIAL_THRESHOLD = 35;
const SOCIAL_RANGE = 10; // tiles
/** Below this age, dwarves don't take mining work — they sleep, socialise,
 * and wander like the children they are. GDD §6.1: childhood 0–18; light
 * hauling 5–18 lands once we have a hauling system. */
const MIN_WORK_AGE = 18;

/**
 * Returns a JobAssignment proposal, or null if the dwarf should remain idle
 * one more tick. Pathfinding to the target is the caller's responsibility.
 */
export function chooseTask(sim: SimWorld, e: EntityId): JobAssignment | null {
  const pos = sim.position.get(e);
  const needs = sim.needs.get(e);
  if (!pos) return null;

  // 1. Critical sleep — drop everything.
  if (needs && needs.sleep <= SLEEP_CRITICAL) {
    const sleepSpot = findRestSpot(sim, pos.x, pos.y);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
    // No spot found — fall through and try other behaviors so the dwarf
    // doesn't get stuck.
  }

  // 2. Work: mine inside an active blueprint. Children are skipped — they
  //    play / sleep / socialise instead, falling through to wander below.
  const age = sim.ageOf(e);
  if (age >= MIN_WORK_AGE) {
    const mineTarget = findMineTarget(sim, pos.x, pos.y);
    if (mineTarget) {
      return { kind: "mine" as JobKind, targetX: mineTarget.x, targetY: mineTarget.y, progress: 0 };
    }
  }

  // 3. Social: find an idle nearby dwarf to talk to.
  if (needs && needs.social <= SOCIAL_THRESHOLD) {
    const partner = findSocialPartner(sim, e, pos.x, pos.y);
    if (partner !== -1) {
      const partnerPos = sim.position.get(partner)!;
      return {
        kind: "socialise" as JobKind,
        targetX: partnerPos.x,
        targetY: partnerPos.y,
        progress: 0,
        partnerId: partner,
      };
    }
  }

  // 4. Wander: pick a random reachable walkable tile.
  const wanderTarget = pickWanderTarget(sim, pos.x, pos.y);
  if (wanderTarget) {
    return { kind: "wander" as JobKind, targetX: wanderTarget.x, targetY: wanderTarget.y, progress: 0 };
  }

  return null;
}

/**
 * Find a walkable tile to rest on. Preference order, strictest first:
 *   1. An actual Bed tile (faster sleep restoration in progressSleep).
 *   2. Any walkable tile inside a completed bedroom.
 *   3. The nearest walkable tile at all.
 * BFS-style scan within a small radius for cheap.
 */
function findRestSpot(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const grid = sim.grid;
  const planner = sim.planner;
  const R = 12;
  let bestBed: { x: number; y: number; dist: number } | null = null;
  let bestBedroom: { x: number; y: number; dist: number } | null = null;
  let bestAny: { x: number; y: number; dist: number } | null = null;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      if (!grid.isWalkable(x, y)) continue;
      const dist = dx * dx + dy * dy;
      const tile = grid.getTile(x, y);
      // Tier 1: an actual Bed.
      if (tile === 11 /* TileType.Bed */) {
        if (!bestBed || dist < bestBed.dist || (dist === bestBed.dist && (y < bestBed.y || (y === bestBed.y && x < bestBed.x)))) {
          bestBed = { x, y, dist };
        }
        continue;
      }
      // Tier 2: walkable tile within a completed bedroom's footprint.
      const inBedroom = planner.blueprints.some(
        (b) =>
          b.kind === "bedroom" &&
          b.status === "complete" &&
          x >= b.originX &&
          x < b.originX + b.width &&
          y >= b.originY &&
          y < b.originY + b.height,
      );
      if (inBedroom) {
        if (!bestBedroom || dist < bestBedroom.dist || (dist === bestBedroom.dist && (y < bestBedroom.y || (y === bestBedroom.y && x < bestBedroom.x)))) {
          bestBedroom = { x, y, dist };
        }
      } else {
        if (!bestAny || dist < bestAny.dist || (dist === bestAny.dist && (y < bestAny.y || (y === bestAny.y && x < bestAny.x)))) {
          bestAny = { x, y, dist };
        }
      }
    }
  }
  if (bestBed) return { x: bestBed.x, y: bestBed.y };
  if (bestBedroom) return { x: bestBedroom.x, y: bestBedroom.y };
  if (bestAny) return { x: bestAny.x, y: bestAny.y };
  return null;
}

/**
 * Find another idle dwarf nearby (no current job) to socialise with.
 * Returns -1 if none found.
 */
function findSocialPartner(sim: SimWorld, self: EntityId, sx: number, sy: number): EntityId {
  const ents = sim.dwarf.entities;
  // Iterate dense array for determinism.
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < ents.length; i++) {
    const other = ents[i];
    if (other === self) continue;
    if (sim.job.has(other)) continue; // already busy
    const op = sim.position.get(other);
    if (!op) continue;
    const dx = op.x - sx;
    const dy = op.y - sy;
    const dist = dx * dx + dy * dy;
    if (dist > SOCIAL_RANGE * SOCIAL_RANGE) continue;
    if (dist < bestDist || (dist === bestDist && other < best)) {
      best = other;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Pick a deterministic random walkable tile within a small radius for an
 * idle wander. Falls back to standing still if no walkable tiles are nearby.
 */
function pickWanderTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const grid = sim.grid;
  const R = 6;
  // Collect candidates in a fixed scan order, then sample one via aiRng.
  const candidates: number[] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = sx + dx;
      const y = sy + dy;
      if (!grid.isWalkable(x, y)) continue;
      candidates.push((y << 16) | x);
    }
  }
  if (candidates.length === 0) return null;
  const idx = sim.aiRng.nextRange(0, candidates.length);
  const c = candidates[idx];
  return { x: c & 0xffff, y: (c >>> 16) & 0xffff };
}
