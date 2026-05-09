// Numerical modifiers derived from a dwarf's traits. Read by the
// systems that care — needsSystem, progress* job ticks, spawnDwarf —
// so traits actually shape behaviour instead of being decorative.
//
// Adding a new trait effect: add a default in `defaultEffects()`, then a
// case in `applyTraitEffects()` for whichever trait should change it.

export interface TraitEffects {
  /** Multiplier applied to job-progress increments. 1.0 = baseline. */
  workSpeed: number;
  /** Multiplier applied to need-decay accumulators. > 1 decays slower
   * (sturdier dwarf), < 1 decays faster (fragile dwarf). */
  needDecay: number;
  /** Multiplier applied to base max HP at spawn. */
  hpScale: number;
  /** Additive offset to the dwarf's morale baseline (50 by default). */
  moraleBaseline: number;
  /** Multiplier on morale gained from socialising. */
  socialMoraleScale: number;
  /** +N effective levels in the named skill at evaluation time. Used by
   * future skill-affinity weighting and (later) by quality scoring. */
  miningBonus: number;
  smithingBonus: number;
  scholarshipBonus: number;
  /** Quality-tier bias on crafted items (GDD §6.3). +1 means a
   * Perfectionist's roll lands one tier above the table; -1 would be
   * a sloppy hand. Clamped to the 0..4 range at use site. */
  qualityBias: number;
}

export function defaultEffects(): TraitEffects {
  return {
    workSpeed: 1,
    needDecay: 1,
    hpScale: 1,
    moraleBaseline: 50,
    socialMoraleScale: 1,
    miningBonus: 0,
    smithingBonus: 0,
    scholarshipBonus: 0,
    qualityBias: 0,
  };
}

/** Fold every trait id into the effect bundle. Unknown trait ids no-op
 * silently so the registry can grow without tripping callers. */
export function effectsFor(traitIds: ReadonlyArray<string>): TraitEffects {
  const e = defaultEffects();
  for (const id of traitIds) applyTraitEffects(e, id);
  return e;
}

function applyTraitEffects(e: TraitEffects, id: string): void {
  switch (id) {
    // Work pace
    case "diligent":
      e.workSpeed *= 1.15;
      break;
    case "lazy":
      e.workSpeed *= 0.85;
      break;
    case "perfectionist":
      e.workSpeed *= 0.8;
      // Slower, but a Perfectionist's roll lands one tier above the
      // table — exactly the GDD §6.5 "produces one quality tier
      // higher on average" rule.
      e.qualityBias += 1;
      break;
    case "efficient":
      e.workSpeed *= 1.1;
      break;
    // Mood baseline
    case "cheerful":
      e.moraleBaseline += 10;
      break;
    case "melancholic":
      e.moraleBaseline -= 10;
      break;
    // Social appetite
    case "gregarious":
      e.socialMoraleScale = 2;
      break;
    case "solitary":
      e.socialMoraleScale = 0;
      break;
    // Constitution
    case "tough":
      e.hpScale *= 1.5;
      break;
    case "frail":
      e.hpScale *= 0.7;
      break;
    case "iron_constitution":
      e.needDecay *= 1.3; // 30% slower decay
      break;
    case "sickly":
      e.needDecay *= 0.75; // 25% faster decay
      break;
    // Skill biases
    case "natural_miner":
      e.miningBonus += 2;
      break;
    case "natural_smith":
      e.smithingBonus += 2;
      break;
    case "natural_scholar":
      e.scholarshipBonus += 2;
      break;
    default:
      // Unrecognised id — likely a flavour-only trait or one whose effect
      // lands in a later session.
      break;
  }
}
