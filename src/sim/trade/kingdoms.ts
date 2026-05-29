// Kingdom trade specialties — each caravan-origin kingdom has its
// own price modifiers and preferred imports, so the player sees a
// real variety of deals over time instead of identical caravans
// rotating through different names. Reputation is tracked per
// kingdom on SimWorld; a kingdom the colony deals with often
// (and never stiffs) gradually offers better prices.
//
// Design intent (indirect control): the player never directly
// picks a caravan or a trade. They influence outcomes by what the
// colony has on hand when the wagons roll up — which they shape
// via existing crafting / hauling / farming sliders. The kingdoms
// here just give the world enough shape that those production
// choices have non-uniform consequences.

import type { Stockpile } from "../world/simWorld";

/** A kingdom's pricing table. `buys` is the per-unit price the
 * kingdom pays for that resource (higher = better deal for the
 * colony). `sells` is the per-unit value imports come in at
 * (higher = the colony gets MORE units per coin paid). Defaults
 * fill in for goods the kingdom has no opinion on. */
export interface KingdomProfile {
  /** Name used in the chronicle ("a caravan from {name}"). */
  name: string;
  /** Short flavour blurb, optional, surfaced in the
   * pre-announcement event when the outrider arrives. */
  hint: string;
  /** Per-resource price multipliers. 1.0 = baseline; 2.0 = pays
   * double for this surplus. Missing entries default to 1.0. */
  buys: Partial<Record<keyof Stockpile, number>>;
  /** Imports the kingdom prefers to bring. The trade picker still
   * favours the colony's lowest staples, but if two imports are
   * equally needed it tie-breaks toward this list (ordered by the
   * kingdom's preference). */
  preferredImports: Array<TradeImport>;
}

/** Goods caravans can bring in exchange. Strict union so the
 * trade system catches typos at compile time. */
export type TradeImport = "food" | "drink" | "tools" | "rope" | "wood" | "cloth" | "leather";

export const KINGDOMS: ReadonlyArray<KingdomProfile> = [
  {
    name: "the western kingdoms",
    hint: "broad farmland; grain and cloth come cheap from their wagons.",
    buys: { stone: 1.2, cut_gems: 1.4 },
    preferredImports: ["food", "drink", "cloth"],
  },
  {
    name: "the Iron Vaults of Karnesh",
    hint: "smiths to a fault; they pay top coin for ore and bars.",
    buys: { ore: 1.8, bars: 1.6, blocks: 0.9 },
    preferredImports: ["tools", "rope"],
  },
  {
    name: "the Hold of Stoneholm",
    hint: "the masons' rival; they'll take blocks at a premium.",
    buys: { blocks: 1.8, stone: 1.4, ore: 0.9 },
    preferredImports: ["food", "tools", "rope"],
  },
  {
    name: "the Bronze Reach",
    hint: "polished jewellers; cut gems double their value at their table.",
    buys: { cut_gems: 2.0, gems: 1.6, bars: 1.2 },
    preferredImports: ["cloth", "leather", "rope"],
  },
  {
    name: "Old Drumheim",
    hint: "ale country; they trade their own brews for stone and timber.",
    buys: { stone: 1.3, wood: 1.5, planks: 1.4 },
    preferredImports: ["drink", "food"],
  },
  {
    name: "the Free Mountain Confederacy",
    hint: "a fair-priced lot; nothing exceptional, but they always come.",
    buys: {},
    preferredImports: ["food", "tools", "rope"],
  },
  {
    name: "the Wandering Hammers guild",
    hint: "tool merchants; they'll part with stockpiles of finished tools.",
    buys: { bars: 1.4, ore: 1.3 },
    preferredImports: ["tools", "rope"],
  },
  {
    name: "the Black Coal Cantons",
    hint: "leatherworkers and tanners; raw hides and cloth move best with them.",
    buys: { leather: 1.6, cloth: 1.5, hide: 1.3 },
    preferredImports: ["leather", "cloth", "tools"],
  },
];

/** Per-kingdom reputation bounds. Reputation starts at 0 for an
 * unmet kingdom; every successful deal nudges it up, every failure
 * (caravan leaves empty-handed) drops it. Caps stop a fortress
 * with a 50-year trade history from getting infinitely good prices. */
export const REPUTATION_MIN = -10;
export const REPUTATION_MAX = 20;

/** How much each successful or failed deal moves the kingdom's
 * reputation. Success outweighs failure so the long-term trend is
 * upward as long as the colony is mostly meeting caravans. */
export const REPUTATION_GAIN_PER_DEAL = 2;
export const REPUTATION_LOSS_PER_MISS = 3;

/** Convert a reputation number into a price multiplier. At rep 0
 * the multiplier is 1.0; at REPUTATION_MAX it's about 1.25 (a 25%
 * better deal); at REPUTATION_MIN it bottoms out around 0.85.
 * Smooth linear curve, no surprise breakpoints. */
export function reputationPriceMultiplier(rep: number): number {
  if (rep >= 0) {
    return 1 + (rep / REPUTATION_MAX) * 0.25;
  }
  return 1 + (rep / Math.abs(REPUTATION_MIN)) * 0.15;
}

export function kingdomByName(name: string): KingdomProfile | null {
  for (const k of KINGDOMS) if (k.name === name) return k;
  return null;
}
