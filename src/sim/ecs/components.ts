// Component data shapes. All POJO, all serializable.

import { SkillLevels } from "../dwarves/skills";
import { SkillXp } from "../dwarves/skillProgress";

export interface Position {
  x: number;
  y: number;
}

export interface Dwarf {
  name: string;
  /** Trait IDs from the registry in dwarves/traits.ts. */
  traitIds: string[];
  /** Per-skill level 1..20 (1 = Novice, 17+ = Legendary). */
  skills: SkillLevels;
  /** Per-skill cumulative XP. Drives level advancement; level shown in
   * `skills` is derived from this and stays in sync via the work systems. */
  skillXp: SkillXp;
  /** Starting profession label (flavour). */
  profession: string;
  /** Tick at which this dwarf was "born". Negative means born before world
   * began (i.e. the founders, who are already adults at game start). Current
   * age = (sim.tick - bornAtTick) / TICKS_PER_YEAR. */
  bornAtTick: number;
  /** Entity id of the bonded partner, or null. Set by pairingSystem;
   * cleared in killDwarf when one of the pair dies. */
  partnerId: number | null;
  /** Tick at which this dwarf last finished a job. Used for tie-breaking idle
   * selection in deterministic order. */
  lastJobTick: number;
  /** True iff this dwarf was born in the colony (mother and father both
   * present at birth). Founders and migrants are false. Used by the
   * Three Generations milestone — it fires when a dwarf is born to two
   * in-colony parents, i.e. all four grandparents lived in the
   * fortress. Optional in saved data: older saves treat everyone as
   * not-born-in-colony, which is the conservative default. */
  bornInColony: boolean;
  /** Grave coordinates of a former partner, or null. Set in killDwarf
   * when the partner is buried in a Cemetery; consulted in chooseTask
   * so the survivor pays their respects when morale dips. Cleared
   * when the survivor pairs with someone new (their grief has eased
   * enough to bond again). */
  lostPartnerGrave?: { x: number; y: number };
  /** Tick of the last grave visit. Cooldown so the survivor doesn't
   * stand at the headstone every hour — once per in-game season is
   * the natural rhythm. */
  lastGraveVisitTick?: number;
  /** Names of this dwarf's mother and father. Set by birthDwarf for
   * colony-born children; undefined for founders + migrants whose
   * lineage isn't recorded. Names (not entity ids) because parents
   * may die and entity ids get reused, while names are stable
   * within a colony's run. The dwarf inspector uses this to render
   * a small family tree (parents alive / deceased, plus siblings
   * computed by matching parentNames). */
  parentNames?: [string, string];
}

export interface Pathing {
  // Packed (y << 16) | x cells. We walk pathIndex forward each move.
  path: Int32Array;
  pathIndex: number;
  // Final destination (the tile we want to be adjacent to, e.g. the rock to mine).
  goalX: number;
  goalY: number;
  /** Sub-tick movement budget (Agile/Slow). Each tick, the dwarf's
   * traitMoveSpeed is added; once the accumulator crosses 1, a step
   * is taken and 1 is subtracted. Defaults to 0 — base-speed dwarves
   * step exactly once per tick (1.0 + 0 = 1.0). Optional in saved
   * data; missing means 0. */
  moveAccum?: number;
}

/**
 * Internal drives. All in 0..100. Decays over real time, restored by
 * matching activity. Once a need crosses a low threshold the dwarf will drop
 * non-emergency work to address it. Hunger / thirst are the most urgent —
 * they can kill if neglected.
 */
export interface Needs {
  /** Sleep — drops continuously; restored by sleeping. */
  sleep: number;
  /** Social — drops slowly; restored by talking with another dwarf. */
  social: number;
  /** Hunger — drops faster than sleep; restored by eating. At 0, the dwarf
   * starves to death. */
  hunger: number;
  /** Thirst — drops fastest; restored by drinking. At 0, the dwarf dies of
   * dehydration. */
  thirst: number;
  /** Morale — derived state in 0..100. Drifts toward the dwarf's
   * trait-adjusted baseline plus a bonus / penalty from how well the
   * other four needs are met. Distressed (below 20) and broken (below
   * 5) thresholds gate trait behaviours and the future tantrum system.
   * Displayed in the dwarf inspector so the player can read the colony's
   * mood at a glance. */
  morale: number;
  /** Internal accumulators for sub-tick decay. */
  decayAccumSleep: number;
  decayAccumSocial: number;
  decayAccumHunger: number;
  decayAccumThirst: number;
  decayAccumMorale: number;
}

/** What's loose on the floor — output of mining and (later) workshops, input
 * to hauling jobs. The kind matches the stockpile counter that the item
 * eventually credits when a hauler delivers it. Items are entities so
 * pathfinding and the renderer can locate them by Position. */
export type ItemKind =
  | "stone" | "ore" | "dirt" | "gem" | "bars" | "tools" | "food" | "drink"
  | "meal" | "wood" | "hide"
  // Slice 1–7 furniture deliverables.
  | "bed" | "barrel" | "table" | "bin" | "stove" | "library_desk"
  | "throne" | "hospital_bed" | "tavern_counter" | "armoury_rack" | "pump_part"
  // Slice 8: workshop deliverables, trade depot, water wheel, farm.
  | "carpenter_bench" | "mason_bench"
  | "smelter_furnace" | "forge_anvil" | "magma_anvil"
  | "jeweller_bench" | "kiln_firebox" | "tannery_vat" | "loom_frame"
  | "trade_scales" | "water_wheel_axle" | "seed_bag"
  // Slice 9: hauling tools — wheelbarrows let a hauler carry up to
  // 8 "size units" of items in one trip (food = 1 unit, ore = 2,
  // bed = 4, etc.), draining piles of farm-cell food and stone
  // backlog faster than the 1-item-per-trip default.
  | "wheelbarrow";

/** Cargo size for the wheelbarrow shared-pool haul system. A
 * wheelbarrow has total capacity WHEELBARROW_CAPACITY; each item
 * picked up consumes its WHEELBARROW_ITEM_SIZE from the load.
 * Items with size ≥ capacity can only ever be carried one at a
 * time (workshop-bench-sized deliverables). */
export const WHEELBARROW_CAPACITY = 8;
export const WHEELBARROW_ITEM_SIZE: Partial<Record<ItemKind, number>> = {
  // Pebble-grade: a wheelbarrow holds a full load.
  stone: 1, dirt: 1, ore: 1, gem: 1,
  food: 1, drink: 1, meal: 1, seed_bag: 1,
  bars: 1, tools: 1,
  // Medium: half a load each.
  wood: 2, hide: 2, pump_part: 2,
  table: 2, bin: 2, stove: 2, library_desk: 2, hospital_bed: 2,
  tavern_counter: 2, armoury_rack: 2,
  // Large: a quarter-load. Two of these fill a wheelbarrow.
  bed: 4, barrel: 4, throne: 4,
  // Workshop benches / kilns / anvils — bulky enough that the
  // wheelbarrow gives no advantage. One trip per item.
  carpenter_bench: 8, mason_bench: 8,
  smelter_furnace: 8, forge_anvil: 8, magma_anvil: 8,
  jeweller_bench: 8, kiln_firebox: 8, tannery_vat: 8, loom_frame: 8,
  trade_scales: 8, water_wheel_axle: 8,
  // A wheelbarrow being hauled itself takes a whole barrow's worth
  // — no carting wheelbarrows by wheelbarrow.
  wheelbarrow: 8,
};

/** Default item size when no explicit entry exists. */
export const WHEELBARROW_DEFAULT_SIZE = 4;

export interface Item {
  kind: ItemKind;
  /** Entity id of the dwarf currently en route to pick this item up, or
   * -1 if unclaimed. Prevents two haulers racing for the same crate. */
  claimedBy: number;
  /** Quality tier in 0..4 (basic, Fine, Superior, Exceptional, Masterwork)
   * per GDD §6.3. Set by progressCraft from the crafter's skill;
   * mining drops always come out at quality 0. Round-trips through
   * save and through hauling. */
  quality?: number;
}

/** Component on a dwarf currently carrying something. While set, the dwarf
 * is in the "deliver to stockpile" half of a haul job. */
export interface Carrying {
  kind: ItemKind;
  /** How many of this kind the dwarf is hauling. 1 by default;
   * higher when a wheelbarrow is checked out from the shared pool
   * (capacity ÷ item-size, capped at WHEELBARROW_CAPACITY / size).
   * Round-trips through save. */
  count?: number;
  /** True iff this haul drew a wheelbarrow from sim.stockpile.wheelbarrows.
   * The wheelbarrow is returned to the pool when the carry empties
   * (delivery or drop-in-place). */
  withWheelbarrow?: boolean;
  /** Quality tier of the carried item — preserved end-to-end so a
   * Masterwork bar reaches the forge as a Masterwork bar, not a
   * baseline one. (Applies to every unit in a stacked carry.) */
  quality?: number;
  /** Where and when the dwarf picked the item up. Used by the
   * stockpile-demand signal: when the elapsed delivery time at a
   * stockpile exceeds FAR_HAUL_TICKS, the colony records the pickup
   * point as a "hot" location and the architect may emit a new
   * stockpile biased toward that side of the map. Optional so older
   * saves and ad-hoc Carrying writes (drop-in-place restorations,
   * test fixtures) still load cleanly. */
  pickedUpAt?: { x: number; y: number; tick: number };
}

/** Membership in the colony's standing military. Auto-assigned at year
 * boundaries based on the dwarf's Military skill — the top fraction of
 * the population is drafted, the rest stay civilian. Squad members chase
 * hostiles instead of fleeing them, deal a flat damage bonus in combat,
 * and answer the Alarm by mustering at the entrance corridor. */
export interface Squad {
  /** Tick at which this dwarf was drafted. Used to age out a soldier
   * back into civilian life if their skill drops below the cap. */
  draftedAtTick: number;
}

/** Personal equipment a dwarf carries — a weapon (or, in later sessions,
 * armour, shields, etc.). Equipped soldiers deal more damage in combat
 * than unequipped ones; civilians can be equipped too but rarely have
 * anything worth picking up. The component sticks with the dwarf for
 * life — demobilising a soldier doesn't take their weapon back. */
export interface Equipment {
  /** True when the dwarf carries a real weapon (a forge tool, in
   * Session 5 terms). Future sessions can add armour, helm, shield,
   * etc., as additional flags. */
  weapon: boolean;
  /** Quality tier of the weapon in 0..4 (basic → Masterwork) per GDD
   * §6.3. Each tier above 0 adds +2 damage in combat. Optional for
   * back-compat with pre-quality saves. */
  weaponQuality?: number;
}

/** The Fury (GDD §6.5 special trait): once-per-life berserk rage that
 * triggers when a bonded dwarf is killed in combat. While set, the
 * dwarf is effectively unkillable and deals huge damage; the rage
 * ends naturally when no hostile is in range, then the dwarf
 * collapses (one-shot, the trait is consumed). */
export interface Fury {
  /** Tick at which the rage was triggered. Used for the optional
   * exhaustion event after the storm passes. */
  startedAtTick: number;
  /** Set to true once the trait has fired — prevents a second rage. */
  used: boolean;
}

/** Obsessive (GDD §6.5 rare trait): the dwarf periodically fixates on
 * a single skill, grinding it at 2× XP for an in-game week, then
 * returns to normal. The component lives on the dwarf only while the
 * grind is active; it's removed when the timer elapses. */
export interface Obsession {
  /** Skill being obsessed over. awardSkillXp doubles XP when the
   * incoming skill matches. */
  skillId: string;
  /** Tick at which the obsession ends and the component is removed. */
  endsAtTick: number;
}

/** Tantrum (GDD §6.4 broken-morale state): a dwarf with sustained
 * very-low morale snaps and refuses productive work for several
 * in-game days. While set, chooseTask skips the work branches —
 * they can still eat, drink, sleep, and wander — and the chronicle
 * notes the breakdown. The component clears once morale rises back
 * above a recovery threshold or the timer elapses. */
export interface Tantrum {
  /** Tick at which the tantrum began. Used to enforce a minimum
   * duration so a one-tick morale spike doesn't immediately undo
   * the breakdown. */
  startedAtTick: number;
  /** Tick at which the tantrum naturally ends regardless of morale. */
  endsAtTick: number;
}

/** Domesticated or domesticatable creature — pets the colony has
 * adopted (or is in the process of adopting). A wild Pet has no
 * owner and accumulates tameProgress when a dwarf with sufficient
 * farming skill stands adjacent. Once tamed, the pet follows its
 * owner around and helps the colony — cave dogs hunt small
 * hostiles (rats, spiders, bats) so the miners don't have to.
 *
 * Rarity is enforced at the spawn site: wild pets only appear
 * roughly once per in-game year. The colony will rarely have more
 * than two or three at a time. */
export interface Pet {
  kind: PetKind;
  /** Owner dwarf entity id once tamed, else -1 for a wild pet. */
  ownerId: number;
  /** Owner's name — preserved when the entity reference dies so
   * the chronicle still reads correctly when the owner passes. */
  ownerName?: string;
  /** Cumulative ticks of taming progress. Once it crosses
   * PET_TAME_THRESHOLD the pet flips from wild to tame. */
  tameProgress: number;
  /** Tick at which the pet was tamed, or -1 if still wild. */
  tamedAtTick: number;
  /** Tick of the last attack this pet made. Used as a per-pet
   * cooldown so they don't tear through hostiles every tick. */
  lastAttackTick: number;
}

export type PetKind = "cave_dog" | "cave_bat" | "cave_falcon";

/** Active illness on a dwarf. Diseases tick HP down slowly while
 * set; recovery comes either from time spent in a Hospital cot with
 * a competent medic on duty, or from sufficient idle / healing
 * time at higher Iron Constitution. The chronicle records each
 * contraction and recovery. */
export interface Disease {
  kind: DiseaseKind;
  /** Tick at which the dwarf first fell ill. Used for the recovery
   * narrative line ("X has recovered after N days") and for
   * difficulty scaling on long illnesses. */
  contractedAtTick: number;
  /** Cumulative ticks of medic-supervised treatment. Once this
   * crosses DISEASE_CURE_THRESHOLD the disease clears. */
  treatProgress: number;
}

export type DiseaseKind =
  /** Mild cave-air illness — light HP drain, easy to shake. */
  | "cave_cough"
  /** Deep Rock fever from prolonged depth exposure — moderate
   * drain, harder to recover from without a hospital. */
  | "deep_fever"
  /** Wound infection — sets in after a severe injury. Fast HP
   * drain; the colony's most lethal disease without medicine. */
  | "wound_sickness";

export type JobKind = "mine" | "sleep" | "socialise" | "wander" | "eat" | "drink" | "tend" | "maintain" | "shelter" | "haul" | "craft" | "engage" | "research" | "pump" | "visit_grave" | "treat" | "trade";

export interface JobAssignment {
  kind: JobKind;
  // Target tile (mine: solid rock; sleep/wander: walkable spot; socialise: partner tile).
  targetX: number;
  targetY: number;
  // Progress in ticks toward completion. Per-kind thresholds in sim.ts.
  progress: number;
  /** For socialise + treat jobs, the partner / patient dwarf entity id. */
  partnerId?: number;
}
