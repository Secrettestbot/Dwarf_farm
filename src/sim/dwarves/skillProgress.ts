// Skill progression: cumulative-XP curves and tier-aware level inference.
// GDD §6.3 caps skills at 20 and uses five named tiers:
//   Novice 1–4, Adequate 5–8, Skilled 9–12, Expert 13–16, Legendary 17–20.
// We use a triangular cumulative XP curve where each new level costs an
// additional flat amount — so reaching Adequate is cheap, Legendary is
// considerably harder, but every level is reachable. At ~1 XP per mined
// tile, a dedicated dwarf reaches Adequate after a few in-game days,
// Skilled after a couple of in-game weeks, Legendary after months.

import { SkillId } from "./skills";

export type SkillXp = Partial<Record<SkillId, number>>;

/** XP cost to advance from level → level+1. */
const XP_PER_NEW_LEVEL = 100;

/**
 * Cumulative XP required to be at exactly `targetLevel`. Level 1 = 0 XP,
 * level 2 = 100, level 3 = 300, level N = 100 × (N-1) × N / 2.
 */
export function xpThreshold(targetLevel: number): number {
  return (XP_PER_NEW_LEVEL * (targetLevel - 1) * targetLevel) / 2;
}

/** Largest level L (1..20) whose threshold is ≤ xp. */
export function levelFromXp(xp: number): number {
  for (let L = 20; L >= 1; L--) {
    if (xp >= xpThreshold(L)) return L;
  }
  return 1;
}

/** Decompose total xp into level + xp-into-current-level + xp-needed-for-next. */
export function progressInLevel(xp: number): {
  level: number;
  xpInLevel: number;
  xpForNext: number;
} {
  const level = levelFromXp(xp);
  const start = xpThreshold(level);
  const next = xpThreshold(level + 1);
  return {
    level,
    xpInLevel: xp - start,
    xpForNext: next - start,
  };
}
