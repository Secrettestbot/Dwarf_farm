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
  /** Visibility radius in tiles around a dwarf — an Eagle-Eyed scout
   * sees further into the fog. Read by visibilitySystem each tick. */
  visibilityRadius: number;
  /** Bereavement morale hit multiplier. Loyal dwarves take a much
   * bigger hit when a bonded dwarf dies; Fickle ones barely notice. */
  bereavementScale: number;
  /** Movement-speed multiplier (GDD §6.5 Agile / Slow). Movement
   * accrues per-tick budget; > 1 means an extra step now and then,
   * < 1 means an occasional skipped step. */
  moveSpeed: number;
  /** Multiplier on morale gained from a high-quality room — Proud
   * dwarves care twice as much, Humble ones half. */
  roomQualityScale: number;
  /** Multiplier on the survival-need interrupt threshold. Focused
   * dwarves resist interruption (lower threshold = need has to bite
   * harder to drop the current job). Distractible ones interrupt at
   * the slightest twinge. Default 1.0. */
  interruptScale: number;
  /** Per-tick chance to abandon a non-survival job out of pure
   * distraction (GDD §6.5). Adds randomness on top of the trait-
   * driven threshold scaling. */
  distractChance: number;
  /** Trade-deal bonus per Charismatic broker (GDD §6.5 Charismatic):
   * stacks multiplicatively on the broker's Trading-skill bonus. */
  tradeBonus: number;
  /** Per-hour passive morale delta this dwarf hands to every other
   * dwarf within LEADER_AURA_RADIUS. Natural Leader sets +1, Antagonistic
   * sets -1. */
  auraMorale: number;
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
    visibilityRadius: 5,
    bereavementScale: 1,
    moveSpeed: 1,
    roomQualityScale: 1,
    interruptScale: 1,
    distractChance: 0,
    tradeBonus: 0,
    auraMorale: 0,
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
    case "focused":
      // Focused dwarves resist interruption — only the most critical
      // need pulls them off the bench.
      e.interruptScale = 0.5;
      break;
    case "distractible":
      // Distractible dwarves interrupt at the slightest twinge AND
      // sometimes drop work for no need-driven reason at all.
      e.interruptScale = 1.5;
      e.distractChance = 0.005;
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
    // Build size — Strong/Slight scale work pace and (later) carry
    // capacity. workSpeed is the most direct hook today.
    case "strong":
      e.workSpeed *= 1.10;
      break;
    case "slight":
      e.workSpeed *= 0.85;
      break;
    // Constitution
    case "tough":
      e.hpScale *= 1.5;
      break;
    case "frail":
      e.hpScale *= 0.7;
      break;
    // Loyalty — affects how hard a partner's death hits the survivor.
    case "loyal":
      e.bereavementScale = 2;
      break;
    case "fickle":
      e.bereavementScale = 0.25;
      break;
    // Senses
    case "eagle_eyed":
      e.visibilityRadius = 8;
      break;
    // Agility — affects how fast the dwarf moves between tiles.
    case "agile":
      e.moveSpeed = 1.20;
      break;
    case "slow":
      e.moveSpeed = 0.80;
      break;
    // Esteem (GDD §6.4) — Proud dwarves care twice as much about
    // room quality, Humble ones a quarter as much.
    case "proud":
      e.roomQualityScale = 2;
      break;
    case "humble":
      e.roomQualityScale = 0.25;
      break;
    case "natural_leader":
      // Captain's presence — nearby dwarves drift upward.
      e.auraMorale = 1;
      break;
    case "antagonistic":
      // Frequent arguments — nearby dwarves drift downward.
      e.auraMorale = -1;
      break;
    case "charismatic":
      // Better trade outcomes (GDD §6.5 — also lifts tavern morale,
      // which lands when the tavern arrives).
      e.tradeBonus = 0.15;
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
