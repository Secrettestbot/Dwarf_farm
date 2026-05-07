// Skills track what a dwarf has practised over their life. GDD §6.3 lists
// industry & support skills with five qualitative tiers (Novice, Adequate,
// Skilled, Expert, Legendary) at level thresholds 1, 5, 9, 13, 17. For
// session 2 we hold the data; per-skill effects on speed/quality are wired up
// in later sessions when the systems they affect (workshops, combat, research)
// come online.

export type SkillId =
  // Industry
  | "mining"
  | "masonry"
  | "carpentry"
  | "smithing"
  | "jewelling"
  | "engineering"
  | "farming"
  | "brewing"
  | "cooking"
  | "loom_tanning"
  // Support
  | "hauling"
  | "medicine"
  | "trading"
  | "military"
  | "archery"
  | "scholarship"
  | "leadership"
  | "artistry";

export interface SkillDef {
  id: SkillId;
  name: string;
  group: "industry" | "support";
  /** One-line description for inspection tooltips. */
  description: string;
}

export const SKILLS: SkillDef[] = [
  { id: "mining", name: "Mining", group: "industry",
    description: "Excavation speed and ore-sense at higher tiers." },
  { id: "masonry", name: "Masonry", group: "industry",
    description: "Quality of stone constructions and carvings." },
  { id: "carpentry", name: "Carpentry", group: "industry",
    description: "Quality of wooden furniture, doors, mechanisms." },
  { id: "smithing", name: "Smithing", group: "industry",
    description: "Quality of forged tools, weapons, and armour." },
  { id: "jewelling", name: "Jewelling", group: "industry",
    description: "Cuts gems and applies inlays." },
  { id: "engineering", name: "Engineering", group: "industry",
    description: "Builds traps, pumps, drawbridges, minecart tracks." },
  { id: "farming", name: "Farming", group: "industry",
    description: "Underground crops; rare deep-earth fungi at higher tiers." },
  { id: "brewing", name: "Brewing", group: "industry",
    description: "Ales for morale; Reserve Ales at Legendary." },
  { id: "cooking", name: "Cooking", group: "industry",
    description: "Prepared meals; Feasts at Legendary." },
  { id: "loom_tanning", name: "Loom & Tanning", group: "industry",
    description: "Cloth and leather goods; tapestries at Legendary." },

  { id: "hauling", name: "Hauling", group: "support",
    description: "Carry capacity and trip efficiency." },
  { id: "medicine", name: "Medicine", group: "support",
    description: "Diagnosis and treatment; surgery at Expert+." },
  { id: "trading", name: "Trading", group: "support",
    description: "Negotiates with caravans." },
  { id: "military", name: "Military", group: "support",
    description: "Melee combat skill." },
  { id: "archery", name: "Archery", group: "support",
    description: "Crossbow accuracy and range." },
  { id: "scholarship", name: "Scholarship", group: "support",
    description: "Library research; deciphers ancient texts." },
  { id: "leadership", name: "Leadership", group: "support",
    description: "Passive morale aura; squad command." },
  { id: "artistry", name: "Artistry", group: "support",
    description: "Engravings, sculptures; Magnum Opus at Legendary." },
];

export const SKILLS_BY_ID: Record<SkillId, SkillDef> = (() => {
  const m = {} as Record<SkillId, SkillDef>;
  for (const s of SKILLS) m[s.id] = s;
  return m;
})();

export type SkillTier = "novice" | "adequate" | "skilled" | "expert" | "legendary";

export function skillTier(level: number): SkillTier {
  if (level >= 17) return "legendary";
  if (level >= 13) return "expert";
  if (level >= 9) return "skilled";
  if (level >= 5) return "adequate";
  return "novice";
}

export function skillTierLabel(level: number): string {
  switch (skillTier(level)) {
    case "legendary": return "Legendary";
    case "expert": return "Expert";
    case "skilled": return "Skilled";
    case "adequate": return "Adequate";
    case "novice": return "Novice";
  }
}

export type SkillLevels = Partial<Record<SkillId, number>>;

/** A new dwarf's baseline skills: 1 in everything (Novice). */
export function blankSkills(): SkillLevels {
  const out: SkillLevels = {};
  for (const s of SKILLS) out[s.id] = 1;
  return out;
}
