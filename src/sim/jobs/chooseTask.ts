// Decide what an idle dwarf should do next. The hierarchy mirrors GDD §6.2:
// critical needs first, then work, then social, then idle wandering. Every
// branch consults seeded RNG when ties must be broken — never Math.random.

import { SimWorld } from "../world/simWorld";
import { JobAssignment, JobKind } from "../ecs/components";
import { EntityId } from "../ecs/world";
import { findMineTarget } from "./chooseJob";
import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../time";
import { TileType } from "../world/tiles";
import { BlueprintKind, isRoomNeglected } from "../planner/blueprint";
import { isShelterMode } from "../emergency";
import { recipeFor } from "../planner/recipes";

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

  // 0. Emergency shelter override — Alarm and Evacuate both pull every
  //    civilian to the Safe Zone (currently the spawn tile). Even hunger
  //    and thirst defer until the panic subsides; that matches the GDD's
  //    "drop their current job (including eating, sleeping, and
  //    socialising)" rule. Lockdown does not pull dwarves — it just
  //    blocks the perimeter and the migration system. Soldiers don't
  //    shelter — they engage; their branch lands two priorities below
  //    survival needs.
  if (isShelterMode(sim.emergency) && !sim.squad.has(e)) {
    return {
      kind: "shelter" as JobKind,
      targetX: sim.spawn.x,
      targetY: sim.spawn.y,
      progress: 0,
    };
  }

  // 0.5 Engage: standing-guard soldiers head toward the nearest reachable
  //     hostile. Civilians are *not* eligible — they flee or shelter via
  //     the alarm path. Engagement supersedes most needs except critical
  //     thirst / hunger / wounds (those branches sit just below).
  if (sim.squad.has(e)) {
    const target = findHostileTarget(sim, pos.x, pos.y);
    if (target) {
      return {
        kind: "engage" as JobKind,
        targetX: target.x,
        targetY: target.y,
        progress: 0,
      };
    }
  }

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
  if (needs && needs.hunger <= HUNGER_CRITICAL && (sim.stockpile.food > 0 || sim.stockpile.meals > 0)) {
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
  //    heads to bed instead of starting a new mining job. The Rest slider
  //    raises (or lowers) the threshold: a high-Rest colony goes to bed
  //    earlier, a low-Rest colony grinds through the night.
  const hour = (sim.tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
  const isNight = hour < NIGHT_END_HOUR || hour >= NIGHT_START_HOUR;
  const restThreshold = NIGHT_REST_THRESHOLD * (sim.sliders.rest * 1.4 + 0.3);
  if (isNight && needs && needs.sleep <= restThreshold) {
    const sleepSpot = findSleepTarget(sim, pos.x, pos.y);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
  }

  const age = sim.ageOf(e);

  // 4.5 Tantrum: a dwarf in breakdown skips every work branch below.
  //     Survival needs above already fired (eat / drink / sleep /
  //     wounded / shelter / engage). Below this point we go straight
  //     to wander — the broken dwarf just paces.
  const inTantrum = sim.tantrum.has(e);
  if (inTantrum) {
    const wanderTarget = pickWanderTarget(sim, pos.x, pos.y);
    if (wanderTarget) {
      return { kind: "wander" as JobKind, targetX: wanderTarget.x, targetY: wanderTarget.y, progress: 0 };
    }
    return null;
  }

  // 5. Tend a farm cell that's getting close to fallow. Higher priority
  //    than mining because a colony with no food loses fast — but lower
  //    than survival needs above. Children skip it. Gated by the Farming
  //    & Brewing slider — set to zero, dwarves stop tending.
  if (age >= MIN_WORK_AGE && sim.sliders.farming > 0.05) {
    const tendTarget = findTendTarget(sim, pos.x, pos.y);
    if (tendTarget) {
      return { kind: "tend" as JobKind, targetX: tendTarget.x, targetY: tendTarget.y, progress: 0 };
    }
  }

  // 6. Maintain a neglected room. Sits between food work and digging:
  //    if a bedroom or dining hall has been left to rot, fix it before
  //    starting new excavation. The architect won't emit a fresh room
  //    until the existing ones are kept up, so a colony of 7 can't
  //    sprawl into a kingdom-sized footprint. Gated loosely by the
  //    Construction slider since it's upkeep work.
  if (age >= MIN_WORK_AGE && sim.sliders.construction > 0.05) {
    const maintainTarget = findMaintainTarget(sim, pos.x, pos.y);
    if (maintainTarget) {
      return { kind: "maintain" as JobKind, targetX: maintainTarget.x, targetY: maintainTarget.y, progress: 0 };
    }
  }

  // 6.5 Haul a loose item to a stockpile or a workshop that wants it.
  //     Sits ahead of new mining so finished cavities don't fill with
  //     debris while dwarves keep opening new tunnels. The dwarf
  //     already carrying something jumps straight to the delivery half
  //     via the early-return below.
  if (age >= MIN_WORK_AGE && sim.sliders.hauling > 0.05) {
    const carrying = sim.carrying.get(e);
    if (carrying) {
      // Workshops that consume this resource get priority — feeding a
      // smelter directly is the colony's reason for hauling ore.
      const workshop = findWorkshopWantingInput(sim, carrying.kind, pos.x, pos.y);
      if (workshop) {
        return { kind: "haul" as JobKind, targetX: workshop.x, targetY: workshop.y, progress: 1 };
      }
      // Tools route to an Armoury rack ahead of the generic stockpile
      // — that's how a colony stores its weapons in the GDD.
      if (carrying.kind === "tools") {
        const rack = findEmptyArmouryRack(sim, pos.x, pos.y);
        if (rack) {
          return { kind: "haul" as JobKind, targetX: rack.x, targetY: rack.y, progress: 1 };
        }
      }
      const drop = findStockpileDrop(sim, pos.x, pos.y);
      if (drop) {
        return { kind: "haul" as JobKind, targetX: drop.x, targetY: drop.y, progress: 1 };
      }
    } else {
      const haul = findHaulTarget(sim, e, pos.x, pos.y);
      if (haul) {
        return { kind: "haul" as JobKind, targetX: haul.x, targetY: haul.y, progress: 0 };
      }
    }
  }

  // 6.7 Craft at a workshop. Gated by the Crafting slider. Skips
  //     workshops whose recipe input isn't in the stockpile so a smelter
  //     with no ore doesn't tie up a dwarf for nothing.
  if (age >= MIN_WORK_AGE && sim.sliders.crafting > 0.05) {
    const craftTarget = findCraftTarget(sim, pos.x, pos.y);
    if (craftTarget) {
      return { kind: "craft" as JobKind, targetX: craftTarget.x, targetY: craftTarget.y, progress: 0 };
    }
  }

  // 6.75 Pump out a nearby flooded tile. Higher priority than research
  //      so the colony actually reclaims its corridors instead of
  //      reading books while the water rises. Only triggers when a
  //      pump station with reachable water exists.
  if (age >= MIN_WORK_AGE && sim.sliders.crafting > 0.05) {
    const pumpTarget = findPumpTarget(sim, pos.x, pos.y);
    if (pumpTarget) {
      return { kind: "pump" as JobKind, targetX: pumpTarget.x, targetY: pumpTarget.y, progress: 0 };
    }
  }

  // 6.8 Research at a Library desk. Gated by the Research slider, and
  //     only fires when there's an active topic to study.
  if (age >= MIN_WORK_AGE && sim.sliders.research > 0.05 && sim.research.current) {
    const desk = findResearchDesk(sim, pos.x, pos.y);
    if (desk) {
      return { kind: "research" as JobKind, targetX: desk.x, targetY: desk.y, progress: 0 };
    }
  }

  // 7. Mine inside an active blueprint. Gated by the Excavation slider —
  //    set to zero, the colony stops digging entirely.
  if (age >= MIN_WORK_AGE && sim.sliders.excavation > 0.05) {
    const mineTarget = findMineTarget(sim, pos.x, pos.y);
    if (mineTarget) {
      return { kind: "mine" as JobKind, targetX: mineTarget.x, targetY: mineTarget.y, progress: 0 };
    }
  }

  // 8. Social: find an idle nearby dwarf to talk to. Slider scales the
  //    threshold so a high-Socialising colony chats more eagerly.
  const socialThreshold = SOCIAL_THRESHOLD * (sim.sliders.socialising * 1.6 + 0.2);
  if (needs && needs.social <= socialThreshold) {
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

  // 8.5 Visit a buried partner's grave. Survivors with a recorded
  //     lostPartnerGrave occasionally walk to the headstone to think,
  //     pay respects, mourn quietly. Gated on morale (only when
  //     they're not feeling great) and a once-per-season cooldown
  //     so the dwarf doesn't loiter at the cemetery indefinitely.
  if (
    age >= MIN_WORK_AGE &&
    sim.dwarf.get(e)?.lostPartnerGrave &&
    needs && needs.morale < GRAVE_VISIT_MORALE_THRESHOLD
  ) {
    const dw = sim.dwarf.get(e)!;
    const last = dw.lastGraveVisitTick ?? -GRAVE_VISIT_COOLDOWN_TICKS;
    if (sim.tick - last >= GRAVE_VISIT_COOLDOWN_TICKS) {
      const grave = dw.lostPartnerGrave!;
      // Verify the headstone is still there — if the cemetery was
      // dug out or somehow lost the tile, skip the visit and the
      // next chooseTask runs without trying again. (Grave tiles
      // never decay back, but defensive code is cheap.)
      if (sim.grid.getTile(grave.x, grave.y) === TileType.Headstone) {
        return {
          kind: "visit_grave" as JobKind,
          targetX: grave.x,
          targetY: grave.y,
          progress: 0,
        };
      }
    }
  }

  // 9. Wander: pick a random reachable walkable tile.
  const wanderTarget = pickWanderTarget(sim, pos.x, pos.y);
  if (wanderTarget) {
    return { kind: "wander" as JobKind, targetX: wanderTarget.x, targetY: wanderTarget.y, progress: 0 };
  }

  return null;
}

/** Below this morale threshold, a survivor with a recorded lost
 * partner walks to the grave. Above it, they're keeping their grief
 * to themselves. */
const GRAVE_VISIT_MORALE_THRESHOLD = 65;
/** One in-game season between visits — once a quarter is the
 * natural mourning rhythm. */
const GRAVE_VISIT_COOLDOWN_TICKS = 60 * 24 * 6; // ~6 in-game days

/**
 * Find the nearest walkable cavity tile inside a *neglected* completed room
 * (any maintainable kind: bedroom, dining hall, stockpile, farm). The dwarf
 * walks onto the tile and the work system stamps the blueprint's
 * `lastMaintainedTick`, resetting the architect's neglect clock for that
 * room. Returns null if every standing room has been kept up — the colony
 * is then free to dig new ones.
 *
 * Rooms that already have another dwarf en-route to maintain them are
 * skipped, so a colony of seven spreads across multiple neglected rooms
 * instead of all converging on the same one.
 */
function findMaintainTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  // Build the set of blueprint ids that already have a maintainer assigned.
  const claimedBlueprintIds = new Set<number>();
  const jEnts = sim.job.entities;
  for (let i = 0; i < jEnts.length; i++) {
    const j = sim.job.get(jEnts[i]);
    if (!j || j.kind !== "maintain") continue;
    for (const b of sim.planner.blueprints) {
      if (b.status !== "complete") continue;
      if (j.targetX < b.originX || j.targetX >= b.originX + b.width) continue;
      if (j.targetY < b.originY || j.targetY >= b.originY + b.height) continue;
      claimedBlueprintIds.add(b.id);
      break;
    }
  }
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (!isRoomNeglected(b, sim.tick)) continue;
    if (claimedBlueprintIds.has(b.id)) continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (!sim.grid.isWalkable(x, y)) continue;
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
 *
 * Cells already targeted by another dwarf's tend job are skipped so the
 * colony spreads its tending instead of swarming one plot.
 */
function findTendTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const claimed = collectJobTargets(sim, "tend");
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
      if (claimed.has((y << 16) | x)) continue;
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

/** Find an unclaimed item on the floor for this dwarf to pick up and
 * mark it claimed in the same call so two haulers running chooseTask in
 * the same tick don't both target it. Returns the item's tile (the dwarf
 * walks onto it). */
function findHaulTarget(sim: SimWorld, hauler: EntityId, sx: number, sy: number): { x: number; y: number } | null {
  let bestEnt = -1;
  let best: { x: number; y: number; d: number } | null = null;
  const ents = sim.item.entities;
  for (let i = 0; i < ents.length; i++) {
    const it = sim.item.get(ents[i]);
    const p = sim.position.get(ents[i]);
    if (!it || !p) continue;
    if (it.claimedBy !== -1 && sim.ecs.isAlive(it.claimedBy)) continue;
    // Skip items already sitting on a workshop station that wants
    // them — those are "delivered", waiting for the crafter to consume.
    // Without this, a hauler picks up the item it just dropped at the
    // smelter and the production chain loops forever.
    if (isItemAtWorkshopDestination(sim, p.x, p.y, it.kind)) continue;
    // Tools sitting on an Armoury rack are "stored" — they wait there
    // for the next draft to equip a soldier. Same loop-prevention
    // logic as the workshop destination skip.
    if (it.kind === "tools" && sim.grid.getTile(p.x, p.y) === TileType.ArmouryRack) continue;
    const dx = p.x - sx;
    const dy = p.y - sy;
    const d = dx * dx + dy * dy;
    if (
      !best ||
      d < best.d ||
      (d === best.d && (p.y < best.y || (p.y === best.y && p.x < best.x)))
    ) {
      best = { x: p.x, y: p.y, d };
      bestEnt = ents[i];
    }
  }
  if (bestEnt !== -1) {
    sim.item.get(bestEnt)!.claimedBy = hauler;
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Find the nearest Armoury rack tile that doesn't already have a tool
 * sitting on it. Caps each rack at one weapon — a fortress with five
 * racks holds five tools without stacking. Returns null if no Armoury
 * exists yet, so haulers fall through to the regular stockpile flow. */
function findEmptyArmouryRack(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "armoury" || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) !== TileType.ArmouryRack) continue;
      // Skip racks that already hold a tool.
      let stocked = false;
      const ents = sim.item.entities;
      for (let j = 0; j < ents.length; j++) {
        const it = sim.item.get(ents[j]);
        const p = sim.position.get(ents[j]);
        if (!it || !p) continue;
        if (p.x === x && p.y === y && it.kind === "tools") {
          stocked = true;
          break;
        }
      }
      if (stocked) continue;
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

/** True if (x, y) is a workshop station whose recipe consumes this
 * resource. Used to mark items as "delivered" — they're not available
 * for re-pickup. */
function isItemAtWorkshopDestination(sim: SimWorld, x: number, y: number, kind: string): boolean {
  const tile = sim.grid.getTile(x, y);
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete") continue;
    const recipe = recipeFor(b.kind);
    if (!recipe) continue;
    if (recipe.station !== tile) continue;
    if (recipe.inputKind !== kind) continue;
    if (x < b.originX || x >= b.originX + b.width) continue;
    if (y < b.originY || y >= b.originY + b.height) continue;
    return true;
  }
  return false;
}

/** Find a workshop that wants this resource as its recipe input and
 * doesn't already have a matching item sitting on its station. Returns
 * the station tile so the dwarf walks onto it and drops the item. The
 * workshop's progress system then consumes the item the next tick.
 *
 * Only resources that exist as ItemKind values can be routed this way
 * — food / drink / bars / tools stay in the global stockpile flow
 * until they get item kinds of their own.
 */
function findWorkshopWantingInput(
  sim: SimWorld,
  kind: string,
  sx: number,
  sy: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete") continue;
    const recipe = recipeFor(b.kind);
    if (!recipe || recipe.inputKind !== kind) continue;
    // Workshop's centre is the workstation — find it.
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) !== recipe.station) continue;
      // Skip if a matching item is already on this tile — no point
      // stacking two delivery jobs at one station.
      let alreadyStocked = false;
      const ents = sim.item.entities;
      for (let j = 0; j < ents.length; j++) {
        const it = sim.item.get(ents[j]);
        const p = sim.position.get(ents[j]);
        if (!it || !p) continue;
        if (p.x === x && p.y === y && it.kind === kind) {
          alreadyStocked = true;
          break;
        }
      }
      if (alreadyStocked) continue;
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

/** Find the nearest walkable cell inside a completed stockpile to drop a
 * carried item. Falls back to standing-on-the-spot delivery (item just
 * gets credited to the global counter) if no stockpile exists yet. */
function findStockpileDrop(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "stockpile" || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (!sim.grid.isWalkable(x, y)) continue;
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

/** Find a pump station tile inside a complete pump room with at least
 * one water tile within PUMP_DRAIN_RADIUS. The pump operator stands on
 * the station while progressPump dries one nearby tile per cycle. */
const PUMP_DRAIN_RADIUS = 12;
function findPumpTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const claimed = collectJobTargets(sim, "pump");
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "pump_station" || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) !== TileType.PumpStation) continue;
      if (claimed.has((y << 16) | x)) continue;
      // Verify there's water within drain radius — no point sending a
      // dwarf to a pump with nothing to pump.
      if (!hasWaterInRange(sim, x, y, PUMP_DRAIN_RADIUS)) continue;
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

function hasWaterInRange(sim: SimWorld, sx: number, sy: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      if (sim.grid.getTile(sx + dx, sy + dy) === TileType.Water) return true;
    }
  }
  return false;
}

/** Find the nearest unclaimed Library desk for a research job. Skips
 * desks already occupied by another scholar so two dwarves don't pile
 * onto the same chair. */
function findResearchDesk(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const claimed = collectJobTargets(sim, "research");
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "library" || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) !== TileType.LibraryDesk) continue;
      if (claimed.has((y << 16) | x)) continue;
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

/** Find the nearest hostile in line-of-sight range. Returns the
 * hostile's tile so the soldier walks adjacent and the existing combat
 * system handles the actual exchange. Range is capped so the colony's
 * military doesn't deplete itself running across the entire fortress
 * for a single rat — hostiles deeper than this end up handled when a
 * soldier wanders into their pursue radius. */
const SOLDIER_ENGAGE_RANGE = 30;
function findHostileTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  const ents = sim.hostile.entities;
  for (let i = 0; i < ents.length; i++) {
    const p = sim.position.get(ents[i]);
    if (!p) continue;
    const dx = p.x - sx;
    const dy = p.y - sy;
    const d = dx * dx + dy * dy;
    if (d > SOLDIER_ENGAGE_RANGE * SOLDIER_ENGAGE_RANGE) continue;
    if (
      !best ||
      d < best.d ||
      (d === best.d && (p.y < best.y || (p.y === best.y && p.x < best.x)))
    ) {
      best = { x: p.x, y: p.y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Find the nearest workstation tile in a completed workshop where the
 * recipe's input is available in the stockpile. Skips workshops already
 * being worked at (claim by job target) so a colony of seven crafters
 * spreads across the workshops it has. */
function findCraftTarget(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const claimed = collectJobTargets(sim, "craft");
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete") continue;
    const recipe = recipeFor(b.kind);
    if (!recipe) continue;
    // Two ways the workshop's input can be available:
    //  - Global stockpile has enough of the input kind (the
    //    pre-routing fallback, still valid for food / drink / bars /
    //    tools that don't have ItemKinds).
    //  - A matching item is sitting on the station (a hauler
    //    delivered it).
    const stationCells: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === recipe.station) stationCells.push({ x, y });
    }
    if (stationCells.length === 0) continue;
    const stockpileHasInput = sim.stockpile[recipe.inputKind] >= recipe.inputQty;
    let routedItemPresent = false;
    if (!stockpileHasInput) {
      const ents = sim.item.entities;
      outer: for (const s of stationCells) {
        for (let i = 0; i < ents.length; i++) {
          const it = sim.item.get(ents[i]);
          const p = sim.position.get(ents[i]);
          if (!it || !p) continue;
          if (p.x === s.x && p.y === s.y && it.kind === recipe.inputKind) {
            routedItemPresent = true;
            break outer;
          }
        }
      }
    }
    if (!stockpileHasInput && !routedItemPresent) continue;
    for (const s of stationCells) {
      if (claimed.has((s.y << 16) | s.x)) continue;
      const dx = s.x - sx;
      const dy = s.y - sy;
      const d = dx * dx + dy * dy;
      if (
        !best ||
        d < best.d ||
        (d === best.d && (s.y < best.y || (s.y === best.y && s.x < best.x)))
      ) {
        best = { x: s.x, y: s.y, d };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Set of packed cells currently targeted by jobs of the given kind.
 * Used to spread work across rooms instead of every dwarf piling onto the
 * same tile. Cheap: a single linear scan over the dense job array. */
function collectJobTargets(sim: SimWorld, kind: JobKind): Set<number> {
  const out = new Set<number>();
  const ents = sim.job.entities;
  for (let i = 0; i < ents.length; i++) {
    const j = sim.job.get(ents[i]);
    if (!j || j.kind !== kind) continue;
    out.add((j.targetY << 16) | j.targetX);
  }
  return out;
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
