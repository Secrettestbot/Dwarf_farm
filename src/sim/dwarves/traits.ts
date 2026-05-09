// Trait registry. Drawn from GDD §6.5 — the 60-trait system spans Work,
// Social, Physical, and Special categories. Every trait has a rarity weight
// (Common 8, Uncommon 3, Rare 1, Special 0.5) used at procgen time. Some
// traits are mutually exclusive (you can't be both Strong and Slight); these
// share a `conflictGroup` string.
//
// Effects are intentionally not implemented yet — they land in later sessions
// as the systems they touch (combat, mood, work-speed, etc.) come online.
// This file is data + a minimal procgen loop.

import { Rng } from "../rng";

export type TraitCategory = "work" | "social" | "physical" | "special";
export type TraitRarity = "common" | "uncommon" | "rare" | "special";

export interface TraitDef {
  id: string;
  name: string;
  category: TraitCategory;
  rarity: TraitRarity;
  /** Brief flavor description for UI tooltips. */
  description: string;
  /** Traits sharing a non-empty conflictGroup are mutually exclusive. */
  conflictGroup?: string;
  /** False for traits that have no mechanical effect today (per the
   * GDD, e.g. Colourblind: "no other negative effect"). rollTraits
   * skips them so every dwarf is guaranteed to land the same count
   * of game-affecting traits. The trait is still listed in the
   * registry — it can show up in the founders-screen swap UI or be
   * granted by hand for narrative reasons. */
  mechanical?: boolean;
}

const RARITY_WEIGHT: Record<TraitRarity, number> = {
  common: 8,
  uncommon: 3,
  rare: 1,
  special: 0.5,
};

export const TRAITS: TraitDef[] = [
  // ---- Work ----
  { id: "diligent", name: "Diligent", category: "work", rarity: "common",
    description: "Works 15% faster. Rarely idles.", conflictGroup: "work_pace" },
  { id: "lazy", name: "Lazy", category: "work", rarity: "common",
    description: "Works 15% slower. Takes frequent rest breaks.", conflictGroup: "work_pace" },
  { id: "focused", name: "Focused", category: "work", rarity: "common",
    description: "Finishes a task before switching, even at low priority.", conflictGroup: "work_focus" },
  { id: "distractible", name: "Distractible", category: "work", rarity: "common",
    description: "Abandons jobs mid-task to investigate nearby events.", conflictGroup: "work_focus" },
  { id: "perfectionist", name: "Perfectionist", category: "work", rarity: "uncommon",
    description: "Slower, but produces higher-quality work." },
  { id: "efficient", name: "Efficient", category: "work", rarity: "uncommon",
    description: "Optimises routing — batches similar jobs." },
  { id: "natural_miner", name: "Natural Miner", category: "work", rarity: "uncommon",
    description: "+2 effective Mining skill. Senses ore within 5 tiles.", conflictGroup: "natural_skill" },
  { id: "natural_smith", name: "Natural Smith", category: "work", rarity: "uncommon",
    description: "+2 effective Smithing skill. Higher Masterwork chance.", conflictGroup: "natural_skill" },
  { id: "natural_scholar", name: "Natural Scholar", category: "work", rarity: "uncommon",
    description: "+2 effective Scholarship. Reads twice as fast.", conflictGroup: "natural_skill" },
  { id: "phobia_deep", name: "Phobia: Deep Rock", category: "work", rarity: "uncommon",
    description: "Severe morale penalty below depth 300.", conflictGroup: "phobia" },
  { id: "phobia_open", name: "Phobia: Open Spaces", category: "work", rarity: "uncommon",
    description: "Severe morale penalty in rooms larger than 10×10.", conflictGroup: "phobia" },
  { id: "night_owl", name: "Night Owl", category: "work", rarity: "rare",
    description: "Full speed at night; 20% slower during the day." },
  { id: "obsessive", name: "Obsessive", category: "work", rarity: "rare",
    description: "Periodically grinds a single skill at 2× speed for an in-game week." },

  // ---- Social ----
  { id: "cheerful", name: "Cheerful", category: "social", rarity: "common",
    description: "Baseline morale +10. Negative events hit 20% softer.", conflictGroup: "mood_baseline" },
  { id: "melancholic", name: "Melancholic", category: "social", rarity: "common",
    description: "Baseline morale −10. More moved by both joy and grief.", conflictGroup: "mood_baseline" },
  { id: "gregarious", name: "Gregarious", category: "social", rarity: "common",
    description: "Doubles morale gained from socialising. Forms friendships fast.", conflictGroup: "social_appetite" },
  { id: "solitary", name: "Solitary", category: "social", rarity: "common",
    description: "Gains no morale from socialising. Thrives alone.", conflictGroup: "social_appetite" },
  { id: "loyal", name: "Loyal", category: "social", rarity: "common",
    description: "Forms deep bonds. Long grief if a bonded dwarf dies.", conflictGroup: "loyalty" },
  { id: "fickle", name: "Fickle", category: "social", rarity: "common",
    description: "Forms and dissolves bonds quickly. Unmoved by most deaths.", conflictGroup: "loyalty" },
  { id: "natural_leader", name: "Natural Leader", category: "social", rarity: "uncommon",
    description: "Nearby dwarves gain a passive morale and speed boost." },
  { id: "antagonistic", name: "Antagonistic", category: "social", rarity: "uncommon",
    description: "Frequent arguments. Excels in solo roles." },
  { id: "empathetic", name: "Empathetic", category: "social", rarity: "uncommon",
    description: "Mood mirrors nearby dwarves. Strong in happy fortresses." },
  { id: "proud", name: "Proud", category: "social", rarity: "uncommon",
    description: "Doubled morale swings from room quality and recognition.", conflictGroup: "humility" },
  { id: "humble", name: "Humble", category: "social", rarity: "rare",
    description: "Largely indifferent to recognition. Hard to impress, hard to break.", conflictGroup: "humility" },
  { id: "charismatic", name: "Charismatic", category: "social", rarity: "rare",
    description: "Better trade outcomes; lifts nearby morale in the tavern." },

  // ---- Physical ----
  { id: "strong", name: "Strong", category: "physical", rarity: "common",
    description: "Carries 30% more. Stronger blows in mining and combat.", conflictGroup: "build_size" },
  { id: "slight", name: "Slight", category: "physical", rarity: "common",
    description: "Carries 20% less. Slightly faster — better at scouting.", conflictGroup: "build_size" },
  { id: "tough", name: "Tough", category: "physical", rarity: "common",
    description: "+50% HP. Recovers faster. Higher pain threshold.", conflictGroup: "constitution_size" },
  { id: "frail", name: "Frail", category: "physical", rarity: "common",
    description: "−30% HP. Longer recovery. Susceptible to disease.", conflictGroup: "constitution_size" },
  { id: "agile", name: "Agile", category: "physical", rarity: "common",
    description: "+20% movement. Better dodge in combat.", conflictGroup: "agility" },
  { id: "slow", name: "Slow", category: "physical", rarity: "common",
    description: "−20% movement. More stable in cave-ins.", conflictGroup: "agility" },
  { id: "iron_constitution", name: "Iron Constitution", category: "physical", rarity: "uncommon",
    description: "Immune to disease. Can eat spoiled food. Resists hazards.", conflictGroup: "health" },
  { id: "sickly", name: "Sickly", category: "physical", rarity: "uncommon",
    description: "Often ill. Needs higher-quality food.", conflictGroup: "health" },
  { id: "eagle_eyed", name: "Eagle-Eyed", category: "physical", rarity: "uncommon",
    description: "Spots threats and structural weaknesses early." },
  { id: "colourblind", name: "Colourblind", category: "physical", rarity: "uncommon",
    description: "Can't distinguish gem types by sight. No other penalty.",
    mechanical: false },
  { id: "ambidextrous", name: "Ambidextrous", category: "physical", rarity: "rare",
    description: "Wields two weapons. Consistent fine craft." },
  { id: "dwarf_touched", name: "Dwarf-Touched", category: "physical", rarity: "rare",
    description: "Ages at half speed. May live to 250+." },

  // ---- Special ----
  { id: "stone_speaker", name: "Stone-Speaker", category: "special", rarity: "special",
    description: "Once per season, senses the largest undiscovered ore vein within 200 tiles." },
  { id: "dream_touched", name: "Dream-Touched", category: "special", rarity: "special",
    description: "Prophetic dreams precede major events." },
  { id: "the_fury", name: "The Fury", category: "special", rarity: "special",
    description: "Once per life: berserk rage if a bonded dwarf is slain." },
  { id: "ancestors_voice", name: "Ancestor's Voice", category: "special", rarity: "special",
    description: "Hears advice from a dead ancestor once per in-game week." },
  { id: "void_sensitive", name: "Void-Sensitive", category: "special", rarity: "special",
    description: "Senses the Hollow King's mood early. Nightmares months in advance." },
  { id: "legendary_born", name: "Legendary Born", category: "special", rarity: "special",
    description: "Begins with one skill at Skilled (9). That skill grows 1.5× faster for life." },
];

export const TRAITS_BY_ID: Record<string, TraitDef> = (() => {
  const m: Record<string, TraitDef> = {};
  for (const t of TRAITS) m[t.id] = t;
  return m;
})();

/**
 * Roll N traits for a single dwarf, respecting:
 *   - rarity weights (common 8, uncommon 3, rare 1, special 0.5)
 *   - conflict groups (no two from the same group)
 *   - category caps (max 1 special)
 *   - skip flavour-only traits so every dwarf is guaranteed N
 *     mechanical traits — fairness across the founders.
 * Deterministic given the rng.
 */
export function rollTraits(rng: Rng, count: number): TraitDef[] {
  const chosen: TraitDef[] = [];
  const usedGroups = new Set<string>();
  let specials = 0;

  // Build a working pool we can sample without replacement. Drop
  // flavour-only traits up front — see TraitDef.mechanical.
  const pool = TRAITS.filter((t) => t.mechanical !== false);

  for (let i = 0; i < count && pool.length > 0; i++) {
    // Filter to currently-eligible candidates.
    const eligible = pool.filter((t) => {
      if (t.conflictGroup && usedGroups.has(t.conflictGroup)) return false;
      if (t.category === "special" && specials >= 1) return false;
      return true;
    });
    if (eligible.length === 0) break;

    const totalWeight = eligible.reduce((s, t) => s + RARITY_WEIGHT[t.rarity], 0);
    const r = rng.nextFloat() * totalWeight;
    let acc = 0;
    let picked: TraitDef = eligible[eligible.length - 1];
    for (const t of eligible) {
      acc += RARITY_WEIGHT[t.rarity];
      if (r < acc) { picked = t; break; }
    }
    chosen.push(picked);
    if (picked.conflictGroup) usedGroups.add(picked.conflictGroup);
    if (picked.category === "special") specials++;
    // Remove from pool so we don't pick the same trait twice.
    const idx = pool.indexOf(picked);
    if (idx >= 0) pool.splice(idx, 1);
  }
  return chosen;
}

/**
 * Suggest 3 alternative traits to swap for `current` on a dwarf at the
 * founders screen. Excludes traits in conflict with the dwarf's other traits.
 */
export function suggestSwaps(rng: Rng, current: TraitDef, others: TraitDef[]): TraitDef[] {
  const usedGroups = new Set(others.map((t) => t.conflictGroup).filter((g): g is string => !!g));
  const eligible = TRAITS.filter((t) => {
    if (t.id === current.id) return false;
    if (t.conflictGroup && usedGroups.has(t.conflictGroup)) return false;
    if (t.category === "special" && others.some((o) => o.category === "special")) return false;
    return true;
  });
  // Weighted pick of 3 distinct.
  const chosen: TraitDef[] = [];
  const pool = eligible.slice();
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const totalWeight = pool.reduce((s, t) => s + RARITY_WEIGHT[t.rarity], 0);
    const r = rng.nextFloat() * totalWeight;
    let acc = 0;
    let picked: TraitDef = pool[pool.length - 1];
    for (const t of pool) {
      acc += RARITY_WEIGHT[t.rarity];
      if (r < acc) { picked = t; break; }
    }
    chosen.push(picked);
    const idx = pool.indexOf(picked);
    if (idx >= 0) pool.splice(idx, 1);
  }
  return chosen;
}
