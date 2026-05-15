// Decide what an idle dwarf should do next. The hierarchy mirrors GDD §6.2:
// critical needs first, then work, then social, then idle wandering. Every
// branch consults seeded RNG when ties must be broken — never Math.random.

import { SimWorld } from "../world/simWorld";
import { JobAssignment, JobKind } from "../ecs/components";
import { EntityId } from "../ecs/world";
import { findMineTarget } from "./chooseJob";
import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../time";
import { TileType } from "../world/tiles";
import { BlueprintKind, FURNITURE_REQUIREMENTS, isRoomNeglected } from "../planner/blueprint";
import { isShelterMode } from "../emergency";
import { recipeFor } from "../planner/recipes";

const SLEEP_CRITICAL = 25;
const SOCIAL_THRESHOLD = 35;
const SOCIAL_CRITICAL = 15;
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
    const sleepSpot = findSleepTarget(sim, pos.x, pos.y, e);
    if (sleepSpot) {
      return { kind: "sleep" as JobKind, targetX: sleepSpot.x, targetY: sleepSpot.y, progress: 0 };
    }
  }

  // 3.5 Critical social — when isolation has dropped social very low,
  //     drop work to find someone. Sits above work but below sleep /
  //     hunger / thirst. Uses the lenient partner search so a busy
  //     colony (where every other dwarf has a mining or hauling job)
  //     still produces matches: a working partner doesn't need to
  //     stop, the chooser just walks over and chats at them while
  //     they work. Both dwarves' social ticks up the whole time.
  if (needs && needs.social <= SOCIAL_CRITICAL) {
    const partner = findSocialPartner(sim, e, pos.x, pos.y, true);
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

  // 4. Circadian rest — at night, a dwarf with at-least-mildly-low sleep
  //    heads to bed instead of starting a new mining job. The Rest slider
  //    raises (or lowers) the threshold: a high-Rest colony goes to bed
  //    earlier, a low-Rest colony grinds through the night.
  const hour = (sim.tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
  const isNight = hour < NIGHT_END_HOUR || hour >= NIGHT_START_HOUR;
  const restThreshold = NIGHT_REST_THRESHOLD * (sim.sliders.rest * 1.4 + 0.3);
  if (isNight && needs && needs.sleep <= restThreshold) {
    const sleepSpot = findSleepTarget(sim, pos.x, pos.y, e);
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

  // 4.7 Treat a sick patient on a hospital cot. Sits above farm tending
  //     and other work — a plague spreads faster than a fallow plot
  //     starves the colony. Only fires for dwarves with at least
  //     Apprentice-level medicine; the patient must already be on a
  //     Hospital cot (their own findSleepTarget routed them there); and
  //     no other medic is already on the way. Walks adjacent to the
  //     patient and stays until the disease clears.
  if (age >= MIN_WORK_AGE) {
    const selfDw = sim.dwarf.get(e);
    if (selfDw && (selfDw.skills.medicine ?? 1) >= MEDIC_MIN_SKILL) {
      const patient = findPatientForTreatment(sim, e, pos.x, pos.y);
      if (patient !== -1) {
        const ppos = sim.position.get(patient)!;
        return {
          kind: "treat" as JobKind,
          targetX: ppos.x,
          targetY: ppos.y,
          progress: 0,
          partnerId: patient,
        };
      }
    }
  }

  // 4.75 Trade — if a caravan is on site and this dwarf is the
  //      assigned broker, walk to the depot to close the deal.
  //      Pre-empts the standard work order: trade is a once-per-
  //      season window and the caravan leaves whether the broker
  //      arrived or not. Falls through silently when this dwarf
  //      isn't the broker, the deal already closed, or no caravan
  //      is on site.
  if (
    age >= MIN_WORK_AGE
    && sim.caravanBrokerId === e
    && !sim.caravanDealComplete
    && sim.caravanLeavesTick > 0
  ) {
    return {
      kind: "trade" as JobKind,
      targetX: sim.caravanX,
      targetY: sim.caravanY,
      progress: 0,
    };
  }

  // 4.8 Specialization — a Skilled+ dwarf prioritizes the work
  //     branch matching their highest skill before the standard work
  //     order. A master miner mines before hauling, a master smith
  //     crafts before tending, a master scholar researches before
  //     mining. Falls through to the standard order when the
  //     specialty branch has no target. Skipped when the dwarf is
  //     carrying something — finishing delivery first.
  if (age >= MIN_WORK_AGE && !sim.carrying.has(e)) {
    const dw = sim.dwarf.get(e);
    if (dw) {
      const specialty = preferredWorkKind(dw);
      if (specialty) {
        const proposal = trySpecialtyBranch(sim, e, pos, specialty);
        if (proposal) return proposal;
      }
    }
  }

  // 5. Tend a farm cell that's getting close to fallow. Capped at
  //    one concurrent tender per farm via findTendTarget — without
  //    that cap every farm with overdue cells (most of them, most
  //    of the time) sucks another idle dwarf into the tend loop
  //    and the haul queue silently collapses. The !carrying gate
  //    prevents the tend → harvest → re-tend loop when a dwarf
  //    finishes a tend holding the harvested food: they fall
  //    through to step 6.5's delivery branch instead.
  if (age >= MIN_WORK_AGE && !sim.carrying.has(e) && sim.sliders.farming > 0.05) {
    const tendTarget = findTendTarget(sim, pos.x, pos.y);
    if (tendTarget) {
      return { kind: "tend" as JobKind, targetX: tendTarget.x, targetY: tendTarget.y, progress: 0 };
    }
  }

  // 6. Maintain a neglected room. !carrying gate for the same
  //    reason as tend — a dwarf holding something needs to drop it
  //    in step 6.5 before starting upkeep work.
  if (age >= MIN_WORK_AGE && !sim.carrying.has(e) && sim.sliders.construction > 0.05) {
    const maintainTarget = findMaintainTarget(sim, pos.x, pos.y);
    if (maintainTarget) {
      return { kind: "maintain" as JobKind, targetX: maintainTarget.x, targetY: maintainTarget.y, progress: 0 };
    }
  }

  // 6.5 Haul a loose item to a stockpile or a workshop that wants it.
  //     Sits ahead of new mining so finished cavities don't fill with
  //     debris while dwarves keep opening new tunnels. The dwarf
  //     already carrying something jumps straight to the delivery
  //     half — the !carrying gates on tend / maintain above route
  //     them here automatically. Carrying-with-no-destination drops
  //     in place and falls THROUGH past the else-pickup branch so
  //     the dwarf doesn't immediately re-grab what they just dropped.
  if (age >= MIN_WORK_AGE && sim.sliders.hauling > 0.05) {
    const carrying = sim.carrying.get(e);
    if (carrying) {
      const workshop = findWorkshopWantingInput(sim, carrying.kind, pos.x, pos.y);
      if (workshop) {
        return { kind: "haul" as JobKind, targetX: workshop.x, targetY: workshop.y, progress: 1 };
      }
      if (carrying.kind === "tools") {
        const rack = findEmptyArmouryRack(sim, pos.x, pos.y);
        if (rack) {
          return { kind: "haul" as JobKind, targetX: rack.x, targetY: rack.y, progress: 1 };
        }
      }
      const furn = findFurnitureRoute(sim, carrying.kind, pos.x, pos.y);
      if (furn) {
        return { kind: "haul" as JobKind, targetX: furn.x, targetY: furn.y, progress: 1 };
      }
      const drop = findStockpileDrop(sim, pos.x, pos.y);
      if (drop) {
        return { kind: "haul" as JobKind, targetX: drop.x, targetY: drop.y, progress: 1 };
      }
      // Nothing wants this item right now. Wheelbarrows credit the
      // colony pool directly — keeping them as floor items causes a
      // pick-up / drop loop on the workshop output tile that starves
      // beds and barrels of haulers (they share the carpenter
      // station tile with a wheelbarrow that has a lower entity ID,
      // so findHaulTarget keeps grabbing the wheelbarrow first).
      // Other kinds sit on the floor so a later needs_furnishing
      // room can claim them.
      const dropCount = carrying.count ?? 1;
      if (carrying.kind === "wheelbarrow") {
        sim.stockpile.wheelbarrows += dropCount;
      } else {
        for (let i = 0; i < dropCount; i++) {
          sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y, quality: carrying.quality });
        }
      }
      if (carrying.withWheelbarrow) sim.stockpile.wheelbarrows++;
      sim.carrying.remove(e);
    } else {
      // Only general-priority dwarves are subject to the hauler
      // cap — a hauling specialist (skill ≥ SPECIALTY_THRESHOLD)
      // gets routed through trySpecialtyBranch above and bypasses
      // this gate. Without the cap, every idle dwarf piles onto
      // haul jobs, leaving nobody at workshops, mining faces, or
      // research desks and making the colony read as a single big
      // haul column.
      const haulerCap = haulerCapForColony(sim);
      if (countActiveHaulers(sim) < haulerCap) {
        const haul = findHaulTarget(sim, e, pos.x, pos.y);
        if (haul) {
          return { kind: "haul" as JobKind, targetX: haul.x, targetY: haul.y, progress: 0 };
        }
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

  // 6.75 Pump out a nearby flooded tile. Sits between crafting and
  //      research so a colony with active workshops still drains
  //      a breach, but doesn't pull the brewer off duty when there's
  //      ongoing brewing to do. Engineers (via the specialty mapping
  //      above) prioritise pumps before this branch ever fires.
  if (age >= MIN_WORK_AGE) {
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
  //    threshold so a high-Socialising colony chats more eagerly. The
  //    moderate-tier branch keeps the strict idle-only partner rule
  //    so a healthy colony doesn't constantly interrupt productive
  //    work for casual chats — the critical branch above handles the
  //    "really needs people" case differently.
  const socialThreshold = SOCIAL_THRESHOLD * (sim.sliders.socialising * 1.6 + 0.2);
  if (needs && needs.social <= socialThreshold) {
    const partner = findSocialPartner(sim, e, pos.x, pos.y, false);
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

/** Skill level above which a dwarf treats a work kind as their
 * specialty. Apprentice-tier (4) — a noticeable step up from
 * Novice without requiring true mastery. Below this, the dwarf
 * has no preferred work and falls through to the standard order. */
const SPECIALTY_THRESHOLD = 4;

/** Pick the work branch matching this dwarf's highest skill that
 * counts as a real specialty (≥ SPECIALTY_THRESHOLD). Returns null
 * if no skill clears the bar. Crafting skills (smithing, cooking,
 * brewing, masonry, jewelling, carpentry, loom_tanning) all map to
 * the generic "craft" branch — the recipe at each station picks the
 * actual skill once the dwarf arrives. */
function preferredWorkKind(dw: import("../ecs/components").Dwarf): JobKind | null {
  const s = dw.skills;
  type Cand = { kind: JobKind; level: number };
  // Take the max across crafting skills so a master smith and a
  // master cook both qualify for "craft" without splitting the score.
  const craftMax = Math.max(
    s.smithing ?? 1,
    s.cooking ?? 1,
    s.brewing ?? 1,
    s.masonry ?? 1,
    s.jewelling ?? 1,
    s.carpentry ?? 1,
    s.loom_tanning ?? 1,
  );
  const candidates: Cand[] = [
    { kind: "mine", level: s.mining ?? 1 },
    { kind: "haul", level: s.hauling ?? 1 },
    { kind: "tend", level: s.farming ?? 1 },
    { kind: "craft", level: craftMax },
    { kind: "research", level: s.scholarship ?? 1 },
    { kind: "treat", level: s.medicine ?? 1 },
    { kind: "pump", level: s.engineering ?? 1 },
    { kind: "maintain", level: s.masonry ?? 1 },
  ];
  let best: Cand | null = null;
  for (const c of candidates) {
    if (c.level < SPECIALTY_THRESHOLD) continue;
    if (!best || c.level > best.level) best = c;
  }
  return best ? best.kind : null;
}

/** Run the specialty-preferred work branch. Mirrors the gates of
 * the standard work order — same slider thresholds, same target
 * helpers — but called BEFORE the standard chain so a specialist
 * picks their craft over the default priority order. Returns a
 * proposal if the branch has a target, null otherwise. */
function trySpecialtyBranch(
  sim: SimWorld,
  e: EntityId,
  pos: { x: number; y: number },
  kind: JobKind,
): JobAssignment | null {
  switch (kind) {
    case "mine": {
      if (sim.sliders.excavation <= 0.05) return null;
      const t = findMineTarget(sim, pos.x, pos.y);
      return t ? { kind: "mine" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    case "haul": {
      if (sim.sliders.hauling <= 0.05) return null;
      const t = findHaulTarget(sim, e, pos.x, pos.y);
      return t ? { kind: "haul" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    case "tend": {
      if (sim.sliders.farming <= 0.05) return null;
      const t = findTendTarget(sim, pos.x, pos.y);
      return t ? { kind: "tend" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    case "craft": {
      if (sim.sliders.crafting <= 0.05) return null;
      const t = findCraftTarget(sim, pos.x, pos.y);
      return t ? { kind: "craft" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    case "research": {
      if (sim.sliders.research <= 0.05 || !sim.research.current) return null;
      const t = findResearchDesk(sim, pos.x, pos.y);
      return t ? { kind: "research" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    case "treat": {
      const dw = sim.dwarf.get(e);
      if (!dw || (dw.skills.medicine ?? 1) < MEDIC_MIN_SKILL) return null;
      const patient = findPatientForTreatment(sim, e, pos.x, pos.y);
      if (patient === -1) return null;
      const ppos = sim.position.get(patient)!;
      return { kind: "treat" as JobKind, targetX: ppos.x, targetY: ppos.y, progress: 0, partnerId: patient };
    }
    case "pump": {
      const t = findPumpTarget(sim, pos.x, pos.y);
      return t ? { kind: "pump" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    case "maintain": {
      if (sim.sliders.construction <= 0.05) return null;
      const t = findMaintainTarget(sim, pos.x, pos.y);
      return t ? { kind: "maintain" as JobKind, targetX: t.x, targetY: t.y, progress: 0 } : null;
    }
    default:
      return null;
  }
}

/** Below this morale threshold, a survivor with a recorded lost
 * partner walks to the grave. Above it, they're keeping their grief
 * to themselves. */
const GRAVE_VISIT_MORALE_THRESHOLD = 65;
/** One in-game season between visits — once a quarter is the
 * natural mourning rhythm. */
const GRAVE_VISIT_COOLDOWN_TICKS = 60 * 24 * 6; // ~6 in-game days
/** Minimum medicine skill to count as a medic. Apprentice-tier (4) is
 * the bar — a colony usually has at least one capable healer once it
 * grows past the founders. Below this, a dwarf stays out of the
 * hospital and the patient lies on the cot recovering passively. */
const MEDIC_MIN_SKILL = 4;

/** Find a sick dwarf lying on a Hospital cot who isn't already being
 * treated by another medic. Returns the patient's entity id, or -1 if
 * none is available. The medic walks adjacent to the patient and
 * begins a `treat` job — the disease system credits the medic's
 * supervised progress while they stay put. */
function findPatientForTreatment(
  sim: SimWorld,
  medic: EntityId,
  sx: number,
  sy: number,
): EntityId {
  // Patients already claimed by an in-flight treat job.
  const claimed = new Set<EntityId>();
  const jEnts = sim.job.entities;
  for (let i = 0; i < jEnts.length; i++) {
    const j = sim.job.get(jEnts[i]);
    if (!j || j.kind !== "treat") continue;
    if (j.partnerId !== undefined && jEnts[i] !== medic) {
      claimed.add(j.partnerId);
    }
  }
  let best = -1;
  let bestDist = Infinity;
  const sick = sim.disease.entities;
  for (let i = 0; i < sick.length; i++) {
    const id = sick[i];
    if (id === medic) continue; // a medic can't treat themselves
    if (claimed.has(id)) continue;
    const ppos = sim.position.get(id);
    if (!ppos) continue;
    if (sim.grid.getTile(ppos.x, ppos.y) !== TileType.HospitalBed) continue;
    const dx = ppos.x - sx;
    const dy = ppos.y - sy;
    const d = dx * dx + dy * dy;
    if (d < bestDist || (d === bestDist && id < best)) {
      best = id;
      bestDist = d;
    }
  }
  return best;
}

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
function findSleepTarget(sim: SimWorld, sx: number, sy: number, e?: EntityId): { x: number; y: number } | null {
  // A sick or wounded dwarf prefers a Hospital cot if one is
  // reachable — that's where their disease can be cured by a medic
  // or their wound healed at the boosted rate. Healthy dwarves go
  // to a bedroom as before.
  if (e !== undefined) {
    const ill = sim.disease.has(e);
    const hp = sim.health.get(e);
    const wounded = hp !== undefined && hp.hp < hp.maxHp * WOUNDED_HP_RATIO;
    if (ill || wounded) {
      const cot = findRoomTarget(sim, "hospital", sx, sy);
      if (cot) return cot;
    }
  }
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
  // Per-tile claim set (prevents two dwarves targeting the same
  // cell) + per-farm claim set (caps tend at one concurrent tender
  // per farm). A single competent farmer handles ~48 tend cycles a
  // day per the recipe math, so one per farm keeps every farm's
  // cells fresh while leaving the other 90% of the workforce free
  // for hauling, crafting, mining, and research. Without the
  // per-farm cap, a 4-farm colony with ~24 overdue cells pulls 24
  // concurrent tenders out of a 25-dwarf population and the haul
  // queue silently collapses.
  const claimedTiles = collectJobTargets(sim, "tend");
  const claimedFarms = new Set<number>();
  const jEnts = sim.job.entities;
  for (let i = 0; i < jEnts.length; i++) {
    const j = sim.job.get(jEnts[i]);
    if (!j || j.kind !== "tend") continue;
    for (const b of sim.planner.blueprints) {
      if (b.kind !== "farm" || b.status !== "complete") continue;
      if (j.targetX < b.originX || j.targetX >= b.originX + b.width) continue;
      if (j.targetY < b.originY || j.targetY >= b.originY + b.height) continue;
      claimedFarms.add(b.id);
      break;
    }
  }
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "farm" || b.status !== "complete") continue;
    if (!b.cellTendedAt) continue;
    if (claimedFarms.has(b.id)) continue;
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
      if (claimedTiles.has((y << 16) | x)) continue;
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
  // Two-pass scan: prefer items wanted by a needs_furnishing room
  // (furniture / workshop bench deliverables) over counter-backed
  // bulk goods (stones, food, ore). A bedroom waiting on its bed
  // shouldn't lose a hauler to the nearest stone three tiles over.
  // Within a tier we still pick the nearest unclaimed candidate.
  let bestEnt = -1;
  let bestTier = -1;
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
    // Items already sitting inside a complete stockpile cavity, with
    // no demand from a needs_furnishing room or a workshop input
    // tile, are effectively in storage — picking them up just to
    // drop them back at the same tile burns simulation cycles
    // (and historically gave the carrier hauling XP). Skip them
    // here; the moment a room emerges that wants the kind, the
    // demand check passes and haulers can route them out.
    if (isItemStoredAtStockpile(sim, p.x, p.y) && !itemHasOpenDemand(sim, it.kind)) continue;
    // Tier 2: furniture (or any non-counter kind) that a
    // needs_furnishing room is actively waiting on. Tier 1: bulk /
    // counter-backed goods. We keep the best candidate from the
    // higher tier we've seen so far; a Tier-2 candidate beats any
    // Tier-1 candidate regardless of distance.
    const tier = isFurnitureKind(it.kind) && hasNeedsFurnishingFor(sim, it.kind) ? 2 : 1;
    if (tier < bestTier) continue;
    const dx = p.x - sx;
    const dy = p.y - sy;
    const d = dx * dx + dy * dy;
    if (
      tier > bestTier ||
      !best ||
      d < best.d ||
      (d === best.d && (p.y < best.y || (p.y === best.y && p.x < best.x)))
    ) {
      best = { x: p.x, y: p.y, d };
      bestEnt = ents[i];
      bestTier = tier;
    }
  }
  if (bestEnt !== -1) {
    sim.item.get(bestEnt)!.claimedBy = hauler;
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** True iff `kind` is a furniture / workshop-bench / room-deliverable
 * item — anything that's NOT stored in a stockpile counter. These
 * kinds get tiered above counter-backed hauls (stones, food) in
 * findHaulTarget so a bed waiting at the carpenter doesn't lose its
 * hauler to a nearer stone. */
function isFurnitureKind(kind: string): boolean {
  switch (kind) {
    case "stone": case "ore": case "dirt": case "gem":
    case "bars": case "tools": case "food": case "drink":
    case "meal": case "wood": case "hide": case "wheelbarrow":
      return false;
  }
  return true;
}

/** True iff some needs_furnishing room is currently listing `kind`
 * as an outstanding requirement. Distinct from the broader
 * itemHasOpenDemand which also returns true for any counter-backed
 * kind. Used to tier furniture hauls above bulk hauls — only the
 * "room-is-waiting" case earns the higher tier. */
function hasNeedsFurnishingFor(sim: SimWorld, kind: string): boolean {
  for (const b of sim.planner.blueprints) {
    if (b.status !== "needs_furnishing") continue;
    const reqs = FURNITURE_REQUIREMENTS[b.kind];
    if (!reqs) continue;
    const placed = b.furniturePlaced?.[kind] ?? 0;
    let need = 0;
    for (const r of reqs) if (r.item === kind) need = r.count;
    if (placed < need) return true;
  }
  return false;
}

/** Cap on the number of dwarves committed to a haul job at once.
 * Keeps a fixed fraction of the population in non-haul roles so the
 * colony reads as a mix of activities rather than a single hauling
 * column. Hauling specialists bypass this — they go through the
 * specialty branch before the general work order kicks in. */
function haulerCapForColony(sim: SimWorld): number {
  // Roughly one in three dwarves, floor 2. With pop=20 → 6 haulers,
  // with pop=7 founders → 2. Lower than that and the colony can't
  // clear farm yield + workshop outputs; higher and idle dwarves
  // all converge on the haul branch.
  return Math.max(2, Math.floor(sim.dwarf.size() / 3));
}

/** Count dwarves currently committed to a haul job — either walking
 * to a pickup (haul progress=0), walking to a delivery (haul
 * progress=1), or already carrying. */
function countActiveHaulers(sim: SimWorld): number {
  let n = 0;
  for (const e of sim.dwarf.entities) {
    if (sim.carrying.has(e)) { n++; continue; }
    const job = sim.job.get(e);
    if (job && job.kind === "haul") n++;
  }
  return n;
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

/** True iff (x, y) is inside the cavity of any complete stockpile
 * blueprint. Used by findHaulTarget to recognise items already
 * stored — picking up a bed from a stockpile when no bedroom needs
 * it just respawns the bed at the dwarf's feet next tick. */
function isItemStoredAtStockpile(sim: SimWorld, x: number, y: number): boolean {
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "stockpile" || b.status !== "complete") continue;
    if (x < b.originX || x >= b.originX + b.width) continue;
    if (y < b.originY || y >= b.originY + b.height) continue;
    return true;
  }
  return false;
}

/** True iff some room or workshop on the map could use a delivery
 * of `kind` right now — a needs_furnishing room that lists it as a
 * requirement, or a complete workshop whose recipe takes it as
 * input. Counter-backed kinds (food, stone, etc.) always return
 * true because the colony's hunger/build chain pulls from the
 * counter, so haulers should keep moving them off the floor. */
function itemHasOpenDemand(sim: SimWorld, kind: string): boolean {
  // Counter-backed kinds always have "open demand" — the colony's
  // stockpile counter accumulates without an explicit room request.
  switch (kind) {
    case "stone": case "ore": case "dirt": case "gem":
    case "bars": case "tools": case "food": case "drink":
    case "meal": case "wood": case "hide": case "wheelbarrow":
      return true;
  }
  for (const b of sim.planner.blueprints) {
    if (b.status === "needs_furnishing") {
      const reqs = FURNITURE_REQUIREMENTS[b.kind];
      if (!reqs) continue;
      const placed = b.furniturePlaced?.[kind] ?? 0;
      let need = 0;
      for (const r of reqs) if (r.item === kind) need = r.count;
      if (placed < need) return true;
    } else if (b.status === "complete") {
      const recipe = recipeFor(b.kind);
      if (recipe && recipe.inputKind === kind) return true;
    }
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

/** True if this tile already holds furniture (Bed, BrewingBarrel)
 * or a workshop station — both reserve the cell from accepting a
 * new furniture delivery. */
function isFurnitureOrStationTile(t: number): boolean {
  return (
    t === TileType.Bed
    || t === TileType.BrewingBarrel
    || t === TileType.Stove
    || t === TileType.Table
    || t === TileType.Bin
    || t === TileType.HospitalBed
    || t === TileType.TavernCounter
    || t === TileType.BreweryStation
    || t === TileType.KitchenStation
    || t === TileType.SmelterStation
    || t === TileType.ForgeStation
    || t === TileType.MasonStation
    || t === TileType.JewellerStation
    || t === TileType.CarpenterStation
    || t === TileType.KilnStation
    || t === TileType.TannerStation
    || t === TileType.LoomStation
    || t === TileType.MagmaForgeStation
    || t === TileType.PumpStation
    || t === TileType.LibraryDesk
    || t === TileType.ArmouryRack
    || t === TileType.Throne
    || t === TileType.TradeScales
    || t === TileType.Door
  );
}

/** Find a needs_furnishing blueprint that wants the carried item.
 * Walks every cavity tile of every blueprint with a remaining
 * requirement matching `kind`, returns the closest. The hauler
 * walks onto that cavity tile; progressHaul recognises the
 * delivery and stamps the corresponding furniture tile. */
function findFurnitureRoute(sim: SimWorld, kind: string, sx: number, sy: number): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "needs_furnishing") continue;
    const reqs = FURNITURE_REQUIREMENTS[b.kind];
    if (!reqs) continue;
    let stillNeeds = false;
    for (const r of reqs) {
      const placed = b.furniturePlaced?.[r.item] ?? 0;
      if (r.item === kind && placed < r.count) {
        stillNeeds = true;
        break;
      }
    }
    if (!stillNeeds) continue;
    // Pick a cavity tile that's walkable (already dug) and not
    // already occupied by furniture or a workshop station. Closest
    // wins; deterministic tiebreak by (y, x).
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (!sim.grid.isWalkable(x, y)) continue;
      if (isFurnitureOrStationTile(sim.grid.getTile(x, y))) continue;
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
    const stockpileHasInput = (sim.stockpile as unknown as Record<string, number>)[recipe.inputKind] >= recipe.inputQty;
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
 * Find a nearby dwarf to socialise with. By default ("strict") only
 * idle dwarves count — chat is leisure, leisure shouldn't interrupt
 * work. When `lenient` is true (called from the critical-social
 * branch in chooseTask), accept any nearby dwarf whose current job
 * isn't a survival or combat one. The chooser walks over and gets
 * social ticks regardless of what the partner is doing — both
 * dwarves' social bumps each tick of progressSocialise. Returns -1
 * if no suitable partner is in range.
 */
function findSocialPartner(sim: SimWorld, self: EntityId, sx: number, sy: number, lenient: boolean): EntityId {
  const ents = sim.dwarf.entities;
  // Iterate dense array for determinism.
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < ents.length; i++) {
    const other = ents[i];
    if (other === self) continue;
    const otherJob = sim.job.get(other);
    if (otherJob) {
      if (!lenient) continue; // strict mode: any job disqualifies
      // Lenient mode: skip survival / combat / shelter jobs but
      // accept work jobs (mine, haul, craft, tend, maintain, etc.).
      const k = otherJob.kind;
      if (k === "eat" || k === "drink" || k === "sleep" || k === "shelter" || k === "engage" || k === "treat") {
        continue;
      }
    }
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
  // Wide radius so idle dwarves disperse instead of clustering at
  // whatever spot they last finished a task (typically the
  // stockpile, where eat / drink / haul-delivery all end). With
  // R=6 a dwarf would land within a few tiles of their previous
  // position every tick, so the colony's idle population pooled
  // around the food counters between meals. A wider random scatter
  // makes idle behavior actually wander.
  const R = 20;
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
