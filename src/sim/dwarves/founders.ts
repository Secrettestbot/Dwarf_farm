// Generate the founding seven dwarves: name, traits, starting skill bias,
// age. Per GDD §6.6 the player can accept the procgen result as-is, rename
// individual dwarves, swap one trait per dwarf, or re-roll the whole group.
// All randomness flows through a seeded Rng so the founders are reproducible.

import { Rng } from "../rng";
import { TraitDef, rollTraits } from "./traits";
import { SKILLS, SkillId, blankSkills, SkillLevels } from "./skills";
import { rollName } from "./names";

export interface Founder {
  name: string;
  traits: TraitDef[];
  skills: SkillLevels;
  /** A starting profession label inferred from skill bias — purely flavour. */
  profession: string;
  /** Age in years. Founders start as adult (20–60). */
  age: number;
}

const STARTING_PROFESSIONS: Array<{ label: string; biasSkill: SkillId; weight: number }> = [
  { label: "Miner", biasSkill: "mining", weight: 5 },
  { label: "Mason", biasSkill: "masonry", weight: 4 },
  { label: "Carpenter", biasSkill: "carpentry", weight: 3 },
  { label: "Smith", biasSkill: "smithing", weight: 3 },
  { label: "Farmer", biasSkill: "farming", weight: 4 },
  { label: "Brewer", biasSkill: "brewing", weight: 2 },
  { label: "Cook", biasSkill: "cooking", weight: 2 },
  { label: "Engineer", biasSkill: "engineering", weight: 2 },
  { label: "Scholar", biasSkill: "scholarship", weight: 2 },
  { label: "Healer", biasSkill: "medicine", weight: 2 },
  { label: "Hauler", biasSkill: "hauling", weight: 3 },
];

function pickProfession(rng: Rng) {
  const total = STARTING_PROFESSIONS.reduce((s, p) => s + p.weight, 0);
  const r = rng.nextFloat() * total;
  let acc = 0;
  for (const p of STARTING_PROFESSIONS) {
    acc += p.weight;
    if (r < acc) return p;
  }
  return STARTING_PROFESSIONS[STARTING_PROFESSIONS.length - 1];
}

/**
 * Generate a single founder. Used by the founders screen for individual
 * re-rolls and by `generateFounders` for the bulk-roll-all flow.
 */
export function generateFounder(rng: Rng, usedNames: Set<string> = new Set()): Founder {
  const name = rollName(rng, usedNames).full;
  // 2–4 traits per GDD §6.5.
  const traitCount = 2 + (Math.floor(rng.nextFloat() * 3));
  const traits = rollTraits(rng, traitCount);
  const skills = blankSkills();
  const prof = pickProfession(rng);
  // Bias the profession's skill up to Adequate-Skilled range. Founders are
  // not legendary; that takes a lifetime of practice.
  skills[prof.biasSkill] = 5 + Math.floor(rng.nextFloat() * 4);
  // Legendary Born trait grants one skill at level 9 — apply if present.
  if (traits.some((t) => t.id === "legendary_born")) {
    // Random skill from any group.
    const s = SKILLS[(rng.nextFloat() * SKILLS.length) | 0];
    skills[s.id] = Math.max(skills[s.id] ?? 1, 9);
  }
  const age = 20 + Math.floor(rng.nextFloat() * 41); // 20–60
  return { name, traits, skills, profession: prof.label, age };
}

export const FOUNDER_COUNT = 7;

/** Generate the full founding seven, deduplicating first names. */
export function generateFounders(rng: Rng): Founder[] {
  const used = new Set<string>();
  const out: Founder[] = [];
  for (let i = 0; i < FOUNDER_COUNT; i++) {
    const f = generateFounder(rng, used);
    used.add(f.name.split(" ")[0]);
    out.push(f);
  }
  return out;
}
