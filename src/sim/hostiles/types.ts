// Cave creatures and other things that bite dwarves. Per GDD §5.2 each
// geological layer has its own roster (cave rats and bats in Shallow Earth,
// trolls and giant spiders in Deep Rock, fire creatures in the Gem Seam,
// and so on). This session we ship the cave rat — the smallest threat —
// to bring the combat / hp / death-from-violence loop online; deeper kinds
// drop in as a data-only addition once the rest is solid.

export type HostileKind = "cave_rat" | "cave_spider" | "goblin_scout" | "cave_troll" | "void_shade" | "hollow_king";

export interface HostileDef {
  id: HostileKind;
  /** Display name for the chronicle. */
  name: string;
  /** Article + name combined ("a cave rat"). */
  spawnArticle: string;
  /** Starting / max HP. */
  maxHp: number;
  /** Damage dealt per attack. */
  damage: number;
  /** Ticks between attacks. */
  attackCooldown: number;
  /** Ticks between movement steps. */
  moveCooldown: number;
  /** Minimum depth (relative to spawn) where this kind appears. */
  minDepth: number;
  /** Pursuit range in tiles. */
  pursueRange: number;
  /** True if killing this kind drops a hide item the colony can tan
   * into leather. Smaller pests (cave rats) and incorporeal threats
   * (void shades, the Hollow King) leave nothing useful behind. */
  dropsHide?: boolean;
}

export const HOSTILE_DEFS: Record<HostileKind, HostileDef> = {
  cave_rat: {
    id: "cave_rat",
    name: "cave rat",
    spawnArticle: "a cave rat",
    maxHp: 30,
    damage: 4,
    attackCooldown: 50,
    moveCooldown: 25,
    minDepth: 30,
    pursueRange: 12,
  },
  // Shallow Earth (§5.2): bats and small spiders — same depth band as
  // cave rats but with a slower attack and faster pursuit, so a spider
  // is a different fight than a rat.
  cave_spider: {
    id: "cave_spider",
    name: "cave spider",
    spawnArticle: "a cave spider",
    maxHp: 25,
    damage: 6,
    attackCooldown: 70,
    moveCooldown: 18,
    minDepth: 60,
    pursueRange: 14,
    dropsHide: true,
  },
  // First proper opponent: a goblin patrol scout. Faster, harder hitter,
  // appears as the colony pushes deeper. The full siege flow lands with
  // squads in Session 5b.
  goblin_scout: {
    id: "goblin_scout",
    name: "goblin scout",
    spawnArticle: "a goblin scout",
    maxHp: 50,
    damage: 8,
    attackCooldown: 60,
    moveCooldown: 22,
    minDepth: 80,
    pursueRange: 18,
    dropsHide: true,
  },
  // Deep Rock (§5.2): cave troll. Slow, brutal, hard to kill — the kind
  // of threat that justifies a permanent military.
  cave_troll: {
    id: "cave_troll",
    name: "cave troll",
    spawnArticle: "a cave troll",
    maxHp: 140,
    damage: 14,
    attackCooldown: 80,
    moveCooldown: 35,
    minDepth: 200,
    pursueRange: 16,
    dropsHide: true,
  },
  // Underworld (§9.4 The Hollow King): a void shade. Spawned only by
  // the Hollow King once they've awakened — never by the regular
  // surface-creature spawn loop. Faster than a troll, hits like steel,
  // appears in any reachable tile (no depth gating once awake).
  void_shade: {
    id: "void_shade",
    name: "void shade",
    spawnArticle: "a void shade",
    maxHp: 90,
    damage: 12,
    attackCooldown: 55,
    moveCooldown: 18,
    minDepth: 0,
    pursueRange: 25,
  },
  // The Hollow King himself (§9.4). Spawns at most once, and only after
  // The King's Name research is complete — the colony has to learn his
  // true name before he can be brought to a fight. Massively higher HP
  // and damage than any other hostile; defeating him is the GDD's
  // ultimate "Legend Run" milestone.
  hollow_king: {
    id: "hollow_king",
    name: "the Hollow King",
    spawnArticle: "the Hollow King",
    maxHp: 800,
    damage: 28,
    attackCooldown: 60,
    moveCooldown: 30,
    minDepth: 1601,
    pursueRange: 40,
  },
};

/**
 * Combat-state component. Carries kind + per-instance counters that the
 * combat / movement systems advance. HP is on the shared Health component
 * so the same death pipeline can apply to dwarves and hostiles uniformly.
 */
export interface Hostile {
  kind: HostileKind;
  lastAttackTick: number;
  lastMoveTick: number;
}

/** HP carried by anything that can be hit — dwarves and hostiles alike. */
export interface Health {
  hp: number;
  maxHp: number;
  /** Last tick this entity attacked. Cooldown gating for retaliation. */
  lastAttackTick: number;
  /** True if HP has dropped below the severe-wound threshold during the
   * current injury episode. Cleared when the dwarf reaches full HP again
   * (and triggers a 'recovered' event in the chronicle). */
  wasSevereWound?: boolean;
}
