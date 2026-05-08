// Cave creatures and other things that bite dwarves. Per GDD §5.2 each
// geological layer has its own roster (cave rats and bats in Shallow Earth,
// trolls and giant spiders in Deep Rock, fire creatures in the Gem Seam,
// and so on). This session we ship the cave rat — the smallest threat —
// to bring the combat / hp / death-from-violence loop online; deeper kinds
// drop in as a data-only addition once the rest is solid.

export type HostileKind = "cave_rat" | "cave_spider" | "goblin_scout" | "cave_troll";

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
