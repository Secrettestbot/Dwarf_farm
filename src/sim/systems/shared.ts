// Cross-cutting sim helpers shared by sim.ts and the systems/ modules:
// job teardown (with reservation release + craft refunds), skill XP,
// milestones, cumulative research counters, and elder checks. Base
// layer of the systems/ decomposition — this module must not import
// from sim.ts or any systems/ sibling.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { levelFromXp } from "../dwarves/skillProgress";
import { skillTier, skillTierLabel, SKILLS_BY_ID, SkillId } from "../dwarves/skills";
import { TileType } from "../world/tiles";
import { effectsFor } from "../dwarves/traitEffects";
import { narrateDeath, narrateBereavement } from "../events/narrator";

export function fireMilestone(sim: SimWorld, id: string, text: string): void {
  if (sim.narrativeMilestones.has(id)) return;
  sim.narrativeMilestones.add(id);
  sim.events.add(sim.tick, "milestone", text);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Increment a dwarf's XP in a skill. If the level advances and the new
 * level crosses a tier boundary (Novice → Adequate, etc.), announce it
 * in the chronicle so the player can watch their veterans become legends.
 */
export function awardSkillXp(sim: SimWorld, e: EntityId, skill: SkillId, amount: number): void {
  const dw = sim.dwarf.get(e);
  if (!dw) return;
  // Obsessive: 2× XP gain on the fixation skill (GDD §6.5).
  const ob = sim.obsession.get(e);
  if (ob && ob.skillId === skill) amount *= 2;
  // Mentoring (GDD §6.1 elder phase): a young dwarf earning XP in a
  // skill gets a small boost when an elder in the same skill is in
  // the colony. Caps at 1.25× so the elders matter without trivialising
  // the grind.
  const learnerAge = sim.ageOf(e);
  if (learnerAge < 30 && (dw.skills[skill] ?? 1) < 13) {
    if (hasElderMentor(sim, skill)) amount *= 1.25;
  }
  const oldXp = dw.skillXp[skill] ?? 0;
  const newXp = oldXp + amount;
  dw.skillXp[skill] = newXp;
  const oldLevel = dw.skills[skill] ?? 1;
  const newLevel = levelFromXp(newXp);
  if (newLevel <= oldLevel) return;
  dw.skills[skill] = newLevel;
  if (skillTier(newLevel) !== skillTier(oldLevel)) {
    const tier = skillTierLabel(newLevel);
    const skillName = SKILLS_BY_ID[skill].name;
    sim.events.add(
      sim.tick,
      "milestone",
      `${dw.name} has become a ${tier} ${skillName}.`,
    );
  }
}

/** Increment the cumulative haul total for a resource by 1. Used at
 * stockpile-credit points (hauling and direct workshop output) to
 * drive material-gated research thresholds. The counter is one-way
 * — gates that pass once stay passed even if the stockpile is
 * later spent. */
export function bumpCumulative(sim: SimWorld, resource: import("../research").MaterialResource): void {
  sim.cumulative[resource] = (sim.cumulative[resource] ?? 0) + 1;
}

/** Age (in years) at which a dwarf enters the Elder phase — slower
 * but wiser per GDD §6.1. Elders craft to a higher tier on average
 * but lose a notch of work speed. */
export const ELDER_AGE = 90;

export function isElder(sim: SimWorld, e: EntityId): boolean {
  return sim.ageOf(e) >= ELDER_AGE;
}

/** True iff there's a living Elder in the colony at Skilled+ in the
 * given skill. Mentoring boost in awardSkillXp gates on this so the
 * elder phase actually transmits expertise to the next generation. */
export function hasElderMentor(sim: SimWorld, skill: SkillId): boolean {
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    if (sim.ageOf(id) < ELDER_AGE) continue;
    if ((dw.skills[skill] ?? 1) >= 9) return true; // Skilled or higher
  }
  return false;
}

/** Clear any floor-item claims held by this dwarf. Must run whenever a
 * pickup-leg haul job is dropped before the item was collected —
 * a dangling claim makes the item invisible to every other hauler for
 * as long as the claimant lives. */
export function releaseItemClaims(sim: SimWorld, e: EntityId): void {
  const ents = sim.item.entities;
  for (let i = 0; i < ents.length; i++) {
    const it = sim.item.get(ents[i]);
    if (it && it.claimedBy === e) it.claimedBy = -1;
  }
}

/** Single exit point for abandoning or completing a job: releases every
 * reservation the job holds (mine-target claims, floor-item claims),
 * then strips the job + pathing components. All release calls are
 * idempotent, so completion paths that already consumed their claim can
 * still route through here. New reservation types wire their release in
 * once, instead of at every one of the ~40 job-removal sites. */
export function dropJob(sim: SimWorld, e: EntityId): void {
  const job = sim.job.get(e);
  if (job) {
    if (job.kind === "mine") sim.releaseMineTarget(job.targetX, job.targetY);
    if (job.kind === "haul") releaseItemClaims(sim, e);
    if (job.kind === "craft" && job.craftPaid) {
      // Craft abandoned after the reservation tick — hand the inputs
      // back. A consumed routed item respawns on the station tile
      // (quality is lost — the half-worked material is what it is);
      // counter debits are re-credited.
      const paid = job.craftPaid;
      const sp = sim.stockpile as unknown as Record<string, number>;
      if (paid.asItem) {
        sim.spawnItem({ kind: paid.kind as import("../ecs/components").ItemKind, x: job.targetX, y: job.targetY });
      } else {
        sp[paid.kind] = (sp[paid.kind] ?? 0) + paid.qty;
      }
      if (paid.kind2 && paid.qty2 !== undefined) {
        sp[paid.kind2] = (sp[paid.kind2] ?? 0) + paid.qty2;
      }
      job.craftPaid = undefined;
    }
  }
  sim.job.remove(e);
  sim.pathing.remove(e);
}


/**
 * Remove a dwarf from the sim, log the death in the chronicle, and
 * place a Memorial tile where they fell. Releases the dwarf's job and
 * reservations, handles The Fury trigger, bereavement, burial, item
 * drops, and grudge pruning.
 */
export function killDwarf(sim: SimWorld, e: EntityId, cause: string): void {
  const dw = sim.dwarf.get(e);
  const pos = sim.position.get(e);
  if (!dw || !pos) return;
  // The Fury (GDD §6.5): once-per-life berserk rage that triggers
  // when a bonded dwarf is killed in combat. Combat-only — death from
  // age, dehydration, or starvation doesn't set the survivor on a
  // war path.
  const violentCause = /slain|gored|torn|crushed|struck/i.test(cause);
  if (violentCause && dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
    const partner = sim.dwarf.get(dw.partnerId);
    if (partner && partner.traitIds.includes("the_fury") && !sim.fury.has(dw.partnerId)) {
      sim.fury.set(dw.partnerId, { startedAtTick: sim.tick, used: false });
      sim.events.add(
        sim.tick,
        "crisis",
        `${partner.name} sees ${dw.name} fall. Something behind their eyes goes still. They do not stop walking forward.`,
      );
    }
  }
  const age = sim.ageOf(e);
  // Free any reservations (mine claim, item claims) with the job.
  dropJob(sim, e);
  // Memorial on the death tile if it's walkable space (a dwarf in transit
  // through a tunnel; not a solid tile that another dwarf is mining).
  if (sim.grid.isWalkable(pos.x, pos.y)) {
    sim.grid.setTile(pos.x, pos.y, TileType.Memorial);
  }
  // Violent deaths fire as crisis so the player gets a notification;
  // peaceful deaths (old age, disease) stay social so the chronicle
  // is the place to read them. The position lets the UI offer a
  // camera-jump to the death tile.
  sim.events.add(
    sim.tick,
    violentCause ? "crisis" : "social",
    narrateDeath(sim.aiRng, dw.name, dw.profession, age, cause),
    { x: pos.x, y: pos.y },
  );
  // Burial: if a Cemetery exists with an empty Grave plot, mark a
  // Headstone there and register the dead dwarf in the colony's
  // gravestones registry. The Memorial tile on the spot they fell
  // still stays (the place they fell is its own kind of marker), but
  // the cemetery is where survivors visit.
  buryDwarf(sim, dw, age, cause);
  // If this dwarf had a partner, clear the survivor's partnerId and log a
  // bereavement event. The relationship's length is approximated as
  // min(both ages) - 18 (i.e. years they could have been bonded as adults),
  // which is good enough for narration without a per-bond pairedAtTick.
  if (dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
    const partner = sim.dwarf.get(dw.partnerId);
    if (partner) {
      const survivorAge = sim.ageOf(dw.partnerId);
      const yearsTogether = Math.max(0, Math.min(age, survivorAge) - 18);
      sim.events.add(
        sim.tick,
        "social",
        narrateBereavement(sim.aiRng, partner.name, dw.name, yearsTogether),
      );
      // Bereavement morale hit, scaled by traits — Loyal grieves
      // hard, Fickle barely notices (GDD §6.5).
      const partnerNeeds = sim.needs.get(dw.partnerId);
      if (partnerNeeds) {
        const scale = effectsFor(partner.traitIds).bereavementScale;
        const hit = Math.round(15 * scale);
        partnerNeeds.morale = Math.max(0, partnerNeeds.morale - hit);
      }
      partner.partnerId = null;
    }
  }
  // If the dwarf was carrying something, drop the whole stack on
  // the death tile so a teammate can finish the haul. Releases any
  // item claim implicitly via the alive-check in findHaulTarget.
  // A checked-out wheelbarrow goes back into the shared pool.
  const carrying = sim.carrying.get(e);
  if (carrying) {
    const dropCount = carrying.count ?? 1;
    for (let i = 0; i < dropCount; i++) {
      sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y, quality: carrying.quality });
    }
    if (carrying.withWheelbarrow) sim.stockpile.wheelbarrows++;
  }
  // Prune grudge entries involving this dwarf — the feud dies with
  // them. The other party feels relieved, not vindicated; we don't
  // bump morale here because grief from buryDwarf already runs.
  for (const key of sim.grudges.keys()) {
    const [a, b] = key.split(":").map(Number);
    if (a === e || b === e) sim.grudges.delete(key);
  }
  // Remove from the ECS, which strips all component stores.
  sim.ecs.destroy(e, [sim.position, sim.dwarf, sim.pathing, sim.job, sim.needs, sim.health, sim.carrying, sim.squad, sim.equipment, sim.fury, sim.obsession, sim.tantrum, sim.disease]);
}


/** Find an empty Grave plot in any complete Cemetery and turn it
 * into a Headstone holding this dwarf's record. The colony's
 * `graves` registry stores the deceased's details so the chronicle
 * + future visit-grave job can reference them. Falls through quietly
 * if no cemetery exists or every plot is already filled — the
 * Memorial tile on the death spot is still there as a fallback. */
function buryDwarf(sim: SimWorld, dw: import("../ecs/components").Dwarf, age: number, cause: string): void {
  let plot: { x: number; y: number } | null = null;
  outer: for (const b of sim.planner.blueprints) {
    if (b.kind !== "cemetery" || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.Grave) {
        plot = { x, y };
        break outer;
      }
    }
  }
  if (!plot) return;
  sim.grid.setTile(plot.x, plot.y, TileType.Headstone);
  sim.graves.push({
    x: plot.x,
    y: plot.y,
    name: dw.name,
    profession: dw.profession,
    ageAtDeath: age,
    deathTick: sim.tick,
    cause,
  });
  // If this dwarf had a partner who's still alive, record the grave
  // location on the survivor so chooseTask can route them to pay
  // respects when their morale dips. The partnerId reference is
  // already cleared by the bereavement branch above; we passed `dw`
  // (the deceased's component) into this helper so the partnerId
  // there is the survivor's id.
  if (dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
    const partner = sim.dwarf.get(dw.partnerId);
    if (partner) partner.lostPartnerGrave = { x: plot.x, y: plot.y };
  }
  sim.events.add(
    sim.tick,
    "social",
    `${dw.name} is laid to rest in the cemetery. Aged ${age} years.`,
  );
}

