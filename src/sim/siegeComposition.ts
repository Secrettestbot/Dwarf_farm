// Siege warband composition. Pulled out of sim.ts as a pure function
// so the escalation curve can be unit-tested without standing up a
// full year-long siege. spawnSiegeWarband() consumes the result and
// spawns the actual hostiles.
//
// The warband scales on two independent axes:
//   - population: a bigger colony is a richer prize, so it draws a
//     bigger raid. This was the original (and only) scaling rule.
//   - tier: the number of the upcoming siege (siegesSurvived + 1).
//     Every siege the colony breaks, the next host comes back harder
//     — more goblins, elite champions from the third siege on, and
//     trolls as living siege-engines at higher tiers. This is what
//     turns a flat "another siege survived" into an escalating war
//     the colony can eventually be overwhelmed by.

export interface SiegeComposition {
  /** Rank-and-file goblin scouts. */
  goblinCount: number;
  /** Elite goblin champions (siege-only kind). */
  championCount: number;
  /** Cave trolls marching with the warband. */
  trollCount: number;
  /** Named warlord leaders (0 or 1). */
  warlordCount: number;
}

/** Hard cap on rank-and-file goblins so a huge colony at a high tier
 * doesn't spawn hundreds of entities in one tick. Trolls + champions
 * stack on top of this, so the real warband ceiling is a bit higher. */
export const MAX_SIEGE_GOBLINS = 28;

/** Compute the warband for the upcoming siege.
 *
 * @param pop            current colony population
 * @param siegesSurvived how many sieges the colony has already broken;
 *                       the upcoming siege is tier (siegesSurvived + 1)
 */
export function siegeComposition(pop: number, siegesSurvived: number): SiegeComposition {
  const tier = Math.max(1, siegesSurvived + 1);

  // Goblins: the original pop-driven base (4 + pop/4), plus two more
  // for each tier beyond the first. Capped so the entity count stays
  // sane on large colonies at high tiers.
  const goblinCount = Math.min(MAX_SIEGE_GOBLINS, 4 + Math.floor(pop / 4) + (tier - 1) * 2);

  // Champions: none for the first two sieges, then one more roughly
  // each tier, capped at 3. They're the warband's shock troops once
  // the colony has proven it can handle a plain rabble.
  const championCount = tier >= 3 ? Math.min(3, tier - 2) : 0;

  // Trolls: the colony-size rule (one at pop ≥ 25) still holds, and
  // from the third siege on the warband brings trolls as siege-engines
  // regardless of colony size — one more every two tiers.
  const trollCount = Math.max(
    pop >= 25 ? 1 : 0,
    tier >= 3 ? Math.floor((tier - 1) / 2) : 0,
  );

  // Warlord: a single named leader once the colony is worth a
  // warlord's personal attention (pop ≥ 15). Unchanged by tier — the
  // escalation shows up as a bigger host under that one banner.
  const warlordCount = pop >= 15 ? 1 : 0;

  return { goblinCount, championCount, trollCount, warlordCount };
}
