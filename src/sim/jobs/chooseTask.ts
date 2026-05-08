// Decide what an idle dwarf should do next. The hierarchy mirrors GDD §6.2:
// critical needs first, then work, then social, then idle wandering. Every
// branch consults seeded RNG when ties must be broken — never Math.random.

import { SimWorld } from "../world/simWorld";
import { JobAssignment, JobKind } from "../ecs/components";
import { EntityId } from "../ecs/world";
import { findMineTarget } from "./chooseJob";
import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../time";
import { TileType } from "../world/tiles";
import { BlueprintKind } from "../planner/blueprint";

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
/** A farm cell counts as "tended" for this many ticks after a dwarf works
 * it. 12 in-game hours = 720 ticks: every cell needs tending roughly
 * twice per in-game day. */
export const TEND_VALIDITY_TICKS = 12 * 60;
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

  // 1. Thirst — fastest-decaying need; can kill in ~24 in-game hours. The
  //    dwarf walks to the nearest stockpile (or dining hall) — they don't
  //    just drink wherever they happen to be standing.
  if (needs && needs.thirst <= THIRST_CRITICAL && sim.stockpile.drink > 0) {
    const target = findFoodTarget(sim, pos.x, pos.y);
    if (target) {
      return { kind: "drink" as JobKind, targetX: target.x, targetY: target.y, progress: 0 };
    }
  }

  // 2. Hunger — second-fastest. Same global stockpile lookup so deep
  //    miners actually go up for a meal.
  if (needs && needs.hunger <= HUNGER_CRITICAL && sim.stockpile.food > 0) {
    const target = findFoodTarget(sim, pos.x, pos.y);
    if (target) {
      return { kind: "eat" as JobKind, targetX: target.x, targetY: target.y, progress: 0 };
    }
  }

  // 3. Critical sleep, or a serious wound — bedroom anywhere in the colony
  //    is preferred over the nearest walkable square. The dwarf will
  //    walk back up to the bedrooms, sleep on a Bed if available, and
  //    get the bed's healing bonus instead of curling up in a tunnel.
  const health = sim.health.get(e);
  const wounded = health !== undefined && health.hp < health.maxHp * WOUNDED_HP_RATIO;
  if ((needs && needs.sleep <= SLEEP_CRITICAL) || wounded) {
    const sleepSpot = findSleepTarget(sim, pos.x, pos.y);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
  }

  // 4. Circadian rest — at night, a dwarf with at-least-mildly-low sleep
  //    heads to bed instead of starting a new mining job.
  const hour = (sim.tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
  const isNight = hour < NIGHT_END_HOUR || hour >= NIGHT_START_HOUR;
  if (isNight && needs && needs.sleep <= NIGHT_REST_THRESHOLD) {
    const sleepSpot = findSleepTarget(sim, pos.x, pos.y);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
  }

  const age = sim.ageOf(e);

  // 5. Tend a farm cell that's getting close to fallow. Higher priority
  //    than mining because a colony with no food loses fast — but lower
  //    than survival needs above. Children skip it.
  if (age >= MIN_WORK_AGE) {
    const tendTarget = findTendTarget(sim, pos.x, pos.y);
    if (tendTarget) {
      return { kind: "tend" as JobKind, targetX: tendTarget.x, targetY: tendTarget.y, progress: 0 };
    }
  }

  // 6. Work: mine inside an active blueprint.
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
 * Find the nearest walkable cell inside a *completed* blueprint of the
 * given kind, anywhere in the world. Used to send hungry / thirsty / tired
 * dwarves up to their stockpile / bedroom even when they're deep in a
 * mine. Within a single room, Bed tiles are preferred (so sleepers actually
 * end up on a bed and get the healing bonus).
 *
 * Returns null if no completed room of the kind exists yet — callers fall
 * back to the local findRestSpot in that case.
 */
function findRoomTarget(
  sim: SimWorld,
  kind: BlueprintKind,
  sx: number,
  sy: number,
): { x: number; y: number } | null {
  let bestPriority: { x: number; y: number; d: number } | null = null;
  let bestSecondary: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== kind || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (!sim.grid.isWalkable(x, y)) continue;
      const dx = x - sx;
      const dy = y - sy;
      const d = dx * dx + dy * dy;
      const tile = sim.grid.getTile(x, y);
      if (tile === TileType.Bed) {
        if (
          !bestPriority ||
          d < bestPriority.d ||
          (d === bestPriority.d && (y < bestPriority.y || (y === bestPriority.y && x < bestPriority.x)))
        ) {
          bestPriority = { x, y, d };
        }
      } else {
        if (
          !bestSecondary ||
          d < bestSecondary.d ||
          (d === bestSecondary.d && (y < bestSecondary.y || (y === bestSecondary.y && x < bestSecondary.x)))
        ) {
          bestSecondary = { x, y, d };
        }
      }
    }
  }
  const best = bestPriority ?? bestSecondary;
  return best ? { x: best.x, y: best.y } : null;
}

/** Best tile to sleep at: a bedroom anywhere first, then nearby walkable. */
function findSleepTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  return findRoomTarget(sim, "bedroom", sx, sy) ?? findRestSpot(sim, sx, sy);
}

/** Best tile to eat / drink at: a stockpile, then a dining hall, then any
 * walkable nearby tile (so a colony with no infrastructure yet can still
 * feed itself from the starter cache). */
function findFoodTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  return (
    findRoomTarget(sim, "stockpile", sx, sy) ??
    findRoomTarget(sim, "dining_hall", sx, sy) ??
    findRestSpot(sim, sx, sy)
  );
}

/**
 * Find the nearest farm cell that is overdue for tending — meaning either
 * it has never been tended, or the last tending was more than
 * TEND_VALIDITY_TICKS ago. The returned tile is the farm cell itself; the
 * dwarf walks onto it and the work system advances `cellTendedAt` while
 * they stand there. Returns null if every cell on every farm is fresh.
 */
function findTendTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "farm" || b.status !== "complete") continue;
    if (!b.cellTendedAt) continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      // Cell may have been overwritten by another blueprint or a cave-in;
      // only count cells that are still actually farm tiles.
      if (sim.grid.getTile(x, y) !== TileType.FarmTile) continue;
      const tendedAt = b.cellTendedAt[i];
      const overdue = tendedAt < 0 || sim.tick - tendedAt > TEND_VALIDITY_TICKS;
      if (!overdue) continue;
      const dx = x - sx;
      const dy = y - sy;
      const d = dx * dx + dy * dy;
      if (
        !best ||
        d < best.d ||
        (d === best.d && (y < best.y || (y === best.y && x < best.x)))
      ) {
        best = { x, y, d };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
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
