// Cross-cutting sim helpers shared by sim.ts and the systems/ modules:
// job teardown (with reservation release + craft refunds), skill XP,
// milestones, cumulative research counters, and elder checks. Base
// layer of the systems/ decomposition — this module must not import
// from sim.ts or any systems/ sibling.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { levelFromXp } from "../dwarves/skillProgress";
import { skillTier, skillTierLabel, SKILLS_BY_ID, SkillId } from "../dwarves/skills";

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

