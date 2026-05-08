// Decide what an idle dwarf should do next. The hierarchy mirrors GDD §6.2:
// critical needs first, then work, then social, then idle wandering. Every
// branch consults seeded RNG when ties must be broken — never Math.random.

import { SimWorld } from "../world/simWorld";
import { JobAssignment, JobKind } from "../ecs/components";
import { EntityId } from "../ecs/world";
import { findMineTarget } from "./chooseJob";
import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../time";

const SLEEP_CRITICAL = 25;
const SOCIAL_THRESHOLD = 35;
const SOCIAL_RANGE = 10; // tiles
const HUNGER_CRITICAL = 30;
const THIRST_CRITICAL = 35;
/** Below this age, dwarves don't take mining work — they sleep, socialise,
 * and wander like the children they are. GDD §6.1: childhood 0–18; light
 * hauling 5–18 lands once we have a hauling system. */
const MIN_WORK_AGE = 18;
/** A dwarf below half HP drops everything to find a bed. Recovery is much
 * faster while sleeping (especially on a bed) so this is the sensible
 * autonomous response. */
const WOUNDED_HP_RATIO = 0.5;
/** During these in-game hours dwarves prefer sleep over work — circadian
 * rhythm. Range is [22:00, 06:00). Night-shift dwarves (later session,
 * night-owl trait) will invert this. */
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;
/** Sleep need below which a night-time dwarf will choose to rest (rather
 * than the harder SLEEP_CRITICAL gate). */
const NIGHT_REST_THRESHOLD = 80;

/**
 * Returns a JobAssignment proposal, or null if the dwarf should remain idle
 * one more tick. Pathfinding to the target is the caller's responsibility.
 */
export function chooseTask(sim: SimWorld, e: EntityId): JobAssignment | null {
  const pos = sim.position.get(e);
  const needs = sim.needs.get(e);
  if (!pos) return null;

  // Priority order, strictest survival need first. Each branch may fall
  // through if no target is found, so a dwarf never gets stuck idle when a
  // lower-priority alternative is reachable.

  // 1. Thirst — fastest-decaying need; can kill in ~24 in-game hours.
  if (needs && needs.thirst <= THIRST_CRITICAL && sim.stockpile.drink > 0) {
    const target = findRestSpot(sim, pos.x, pos.y);
    if (target) {
      return { kind: "drink" as JobKind, targetX: target.x, targetY: target.y, progress: 0 };
    }
  }

  // 2. Hunger — second-fastest. Same model: walk somewhere walkable to eat.
  //    Real food sources (bins in stockpile rooms) replace this in a later
  //    session once hauling is implemented.
  if (needs && needs.hunger <= HUNGER_CRITICAL && sim.stockpile.food > 0) {
    const target = findRestSpot(sim, pos.x, pos.y);
    if (target) {
      return { kind: "eat" as JobKind, targetX: target.x, targetY: target.y, progress: 0 };
    }
  }

  // 3. Critical sleep, or a serious wound — either drops everything to
  //    find a bed. Healing is much faster while sleeping (especially on a
  //    bed), so this is the right autonomous response to a near-fatal hit.
  const health = sim.health.get(e);
  const wounded = health !== undefined && health.hp < health.maxHp * WOUNDED_HP_RATIO;
  if ((needs && needs.sleep <= SLEEP_CRITICAL) || wounded) {
    const sleepSpot = findRestSpot(sim, pos.x, pos.y);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
  }

  // 4. Circadian rest — at night, a dwarf with at-least-mildly-low sleep
  //    heads to bed instead of starting a new mining job. Survival needs
  //    above (1-3) still come first; this is the soft preference that
  //    gives the colony a visible day / night rhythm.
  const hour = (sim.tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
  const isNight = hour < NIGHT_END_HOUR || hour >= NIGHT_START_HOUR;
  if (isNight && needs && needs.sleep <= NIGHT_REST_THRESHOLD) {
    const sleepSpot = findRestSpot(sim, pos.x, pos.y);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
  }

  // 5. Work: mine inside an active blueprint. Children are skipped — they
  //    play / sleep / socialise instead, falling through to wander below.
  const age = sim.ageOf(e);
  if (age >= MIN_WORK_AGE) {
    const mineTarget = findMineTarget(sim, pos.x, pos.y);
    if (mineTarget) {
      return { kind: "mine" as JobKind, targetX: mineTarget.x, targetY: mineTarget.y, progress: 0 };
    }
  }

  // 6. Social: find an idle nearby dwarf to talk to.
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

  // 7. Wander: pick a random reachable walkable tile.
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
