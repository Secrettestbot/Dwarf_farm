// Research tree (GDD §10.2). Tier 1 + Tier 2 are fully wired here;
// Tier 3+ topics arrive in later sessions when their gates (deep-rock
// access, ancient-ruin discovery, gem cutting, etc.) are reachable.
//
// The simulation is intentionally minimal: each topic has a fixed
// research cost in ticks, and at most one topic is studied at a time
// by whoever is sitting at a Library desk. When the cost is paid, the
// topic completes and the chronicle records it. Production gates on
// research land in a follow-up — for now the tree is a parallel
// progression counter the player can watch grow.

export type ResearchTier = 1 | 2 | 3 | 4 | 5 | 6;

/** Multiplier applied to every topic's declared cost when consumed
 * by progressResearch. The base costs in this file describe the
 * relative effort of each topic; the scaler tunes the overall
 * pace so a moderate colony spends in-game years (not weeks)
 * working through the tree. Increase to slow research, decrease
 * to speed it up. */
export const RESEARCH_COST_SCALE = 4;

/** Resource counter (matches Stockpile keys) used for material
 * prereqs. Iron Smelting requires having mined ore, Pottery & Kilns
 * requires dirt, etc. */
export type MaterialResource =
  | "ore" | "stone" | "dirt" | "wood" | "hide" | "rope"
  | "bars" | "gems" | "blocks" | "leather";

/** A material gate on a research topic. Either the colony has
 * accumulated some minimum of a stockpile resource, or it has
 * sensed a particular tile type (gems / magma / void) on the map.
 * Topics may carry multiple gates — all must pass. */
export interface MaterialGate {
  /** Stockpile counter that must reach `min` (inclusive). The check
   * uses the cumulative haul total — once the threshold is crossed
   * the gate stays open even if the stockpile is later spent. */
  resource?: MaterialResource;
  min?: number;
  /** Numeric TileType the colony must have discovered (mined or
   * uncovered by visibility). Gates that depend on rare or layer-
   * specific materials use this — Magma Tapping wants a vent seen,
   * Adamantite Smelting wants the metal mined. */
  tile?: number;
  /** Human-readable description shown in the research panel for a
   * locked topic. e.g. "10 ore mined" or "a gem vein discovered". */
  describe: string;
}

export interface ResearchTopic {
  id: string;
  name: string;
  tier: ResearchTier;
  /** Total scholarship-ticks required to complete. */
  cost: number;
  /** Topic ids that must be complete before this one becomes available. */
  prereqs: string[];
  /** Material prereqs — the colony must have actually worked with
   * (or discovered) the materials before scholars can study the
   * subject. Optional: omitted = no material gate. */
  materials?: MaterialGate[];
}

/** GDD Tier 1 — Craft Fundamentals. The founders brought basic
 * knowledge of stone, wood, cooking, and brewing — those topics
 * unlock from day one. Iron-related Tier 1 topics gate on ore /
 * bars: a colony that's never seen ore can't research smelting. */
export const TIER_1_TOPICS: ResearchTopic[] = [
  { id: "basic_stonecutting", name: "Basic Stonecutting", tier: 1, cost: 600, prereqs: [] },
  { id: "basic_carpentry", name: "Basic Carpentry", tier: 1, cost: 600, prereqs: [] },
  { id: "iron_smelting", name: "Iron Smelting", tier: 1, cost: 800, prereqs: [],
    materials: [{ resource: "ore", min: 3, describe: "3 ore mined" }] },
  { id: "iron_toolmaking", name: "Iron Toolmaking", tier: 1, cost: 800, prereqs: ["iron_smelting"],
    materials: [{ resource: "bars", min: 1, describe: "1 iron bar smelted" }] },
  { id: "basic_cooking", name: "Basic Cooking", tier: 1, cost: 500, prereqs: [] },
  { id: "basic_brewing", name: "Basic Brewing", tier: 1, cost: 500, prereqs: [] },
  { id: "rope_and_fibre", name: "Rope & Fibre", tier: 1, cost: 600, prereqs: [] },
];

/** GDD Tier 2 — Applied Engineering. Each requires one or more Tier 1
 * topics; full prerequisite checks happen below in `availableTopics`. */
export const TIER_2_TOPICS: ResearchTopic[] = [
  {
    id: "masonry_and_mortaring",
    name: "Masonry & Mortaring",
    tier: 2,
    cost: 900,
    prereqs: ["basic_stonecutting"],
  },
  {
    id: "carpentry_mechanisms",
    name: "Carpentry: Mechanisms",
    tier: 2,
    cost: 900,
    prereqs: ["basic_carpentry", "rope_and_fibre"],
  },
  {
    id: "steel_alloying",
    name: "Steel Alloying",
    tier: 2,
    cost: 1100,
    prereqs: ["iron_smelting", "masonry_and_mortaring"],
    materials: [{ resource: "bars", min: 5, describe: "5 iron bars smelted" }],
  },
  {
    id: "armoury_basics",
    name: "Armoury Basics",
    tier: 2,
    cost: 1000,
    prereqs: ["iron_toolmaking"],
  },
  {
    id: "medical_practice",
    name: "Medical Practice",
    tier: 2,
    cost: 900,
    prereqs: [],
  },
  {
    id: "textile_craft",
    name: "Textile Craft",
    tier: 2,
    cost: 800,
    prereqs: ["rope_and_fibre"],
    materials: [{ resource: "rope", min: 3, describe: "3 fibre harvested" }],
  },
  {
    id: "underground_agriculture",
    name: "Underground Agriculture",
    tier: 2,
    cost: 900,
    prereqs: ["basic_cooking", "basic_brewing"],
  },
  {
    id: "minecart_tracks",
    name: "Minecart Tracks",
    tier: 2,
    cost: 1000,
    prereqs: ["iron_toolmaking", "carpentry_mechanisms"],
  },
  {
    id: "pottery_and_kilns",
    name: "Pottery & Kilns",
    tier: 2,
    cost: 800,
    prereqs: ["basic_stonecutting"],
    materials: [{ resource: "dirt", min: 10, describe: "10 dirt accumulated" }],
  },
  {
    // Hydraulic Basics — the colony's first water-management topic.
    // Gates the Pump Station blueprint so a fortress that's breached
    // an aquifer can drain it. Was previously referenced by the
    // planner but missing from the tree, which silently disabled
    // pumping entirely.
    id: "hydraulic_basics",
    name: "Hydraulic Basics",
    tier: 2,
    cost: 1000,
    prereqs: ["carpentry_mechanisms"],
  },
];

/** GDD Tier 3 — Advanced Craft & Military. Unlocks military depth and
 * the gem economy. Gem topics gate on actually discovering a gem
 * vein; Fortification Design gates on stonework experience. */
export const TIER_3_TOPICS: ResearchTopic[] = [
  { id: "advanced_metallurgy", name: "Advanced Metallurgy", tier: 3, cost: 1400, prereqs: ["steel_alloying"],
    materials: [{ resource: "bars", min: 20, describe: "20 bars produced" }] },
  { id: "weaponsmithing", name: "Weaponsmithing", tier: 3, cost: 1300, prereqs: ["armoury_basics", "advanced_metallurgy"] },
  { id: "military_tactics", name: "Military Tactics", tier: 3, cost: 1500, prereqs: ["weaponsmithing"] },
  { id: "fortification_design", name: "Fortification Design", tier: 3, cost: 1500, prereqs: ["masonry_and_mortaring", "carpentry_mechanisms"],
    materials: [{ resource: "blocks", min: 10, describe: "10 stone blocks cut" }] },
  { id: "gem_cutting", name: "Gem Cutting", tier: 3, cost: 1200, prereqs: [],
    materials: [{ tile: 21, describe: "a gem vein discovered" }] }, // RawDiamond — any gem tile counts (see hasMaterials).
  { id: "gem_inlay", name: "Gem Inlay", tier: 3, cost: 1300, prereqs: ["gem_cutting"] },
  { id: "advanced_medicine", name: "Advanced Medicine", tier: 3, cost: 1300, prereqs: ["medical_practice"] },
];

/** GDD Tier 4 — Deep Knowledge. Each topic requires the colony to
 * have actually descended far enough to encounter the relevant
 * landmark — magma vents, ancient ruins. Without the discovery
 * the scholars have nothing to study. */
export const TIER_4_TOPICS: ResearchTopic[] = [
  { id: "magma_tapping", name: "Magma Tapping", tier: 4, cost: 1800, prereqs: ["advanced_metallurgy"],
    materials: [{ tile: 24, describe: "a magma vent discovered" }] }, // MagmaVent
  { id: "magma_forge_craft", name: "Magma Forge Craft", tier: 4, cost: 1900, prereqs: ["magma_tapping"] },
  { id: "relic_analysis", name: "Relic Analysis", tier: 4, cost: 2000, prereqs: ["advanced_medicine"],
    materials: [{ tile: 25, describe: "an ancient ruin discovered" }] }, // AncientRuin
  { id: "alchemy_basics", name: "Alchemy Basics", tier: 4, cost: 1700, prereqs: ["advanced_medicine"] },
  { id: "deep_cartography", name: "Deep Cartography", tier: 4, cost: 1600, prereqs: ["advanced_metallurgy"] },
];

/** GDD Tier 5 — Ancient Lore. Adamantite Smelting needs the metal
 * actually mined; Tier 5 lore otherwise gates on the deeper prereq
 * chain. */
export const TIER_5_TOPICS: ResearchTopic[] = [
  { id: "adamantite_smelting", name: "Adamantite Smelting", tier: 5, cost: 2500, prereqs: ["magma_forge_craft"],
    materials: [{ tile: 26, describe: "adamantite mined" }] }, // Adamantite
  { id: "rune_inscription", name: "Rune Inscription", tier: 5, cost: 2500, prereqs: ["relic_analysis"] },
  { id: "void_engineering", name: "Void Engineering", tier: 5, cost: 2700, prereqs: ["alchemy_basics", "relic_analysis"] },
  { id: "the_deep_breath", name: "The Deep Breath", tier: 5, cost: 2400, prereqs: ["alchemy_basics"] },
];

/** GDD Tier 6 — Void Science. The final research topics. Void
 * Metallurgy needs void-ore mined — the colony has to push into
 * Layer 6 before it can study it. */
export const TIER_6_TOPICS: ResearchTopic[] = [
  { id: "void_metallurgy", name: "Void Metallurgy", tier: 6, cost: 3500, prereqs: ["adamantite_smelting", "void_engineering"],
    materials: [{ tile: 27, describe: "void-ore mined" }] }, // VoidOre
  { id: "anchor_runes", name: "Anchor Runes", tier: 6, cost: 3500, prereqs: ["rune_inscription", "void_engineering"] },
  { id: "the_kings_name", name: "The King's Name", tier: 6, cost: 5000, prereqs: ["void_metallurgy", "anchor_runes"] },
];

export const ALL_TOPICS: ResearchTopic[] = [
  ...TIER_1_TOPICS,
  ...TIER_2_TOPICS,
  ...TIER_3_TOPICS,
  ...TIER_4_TOPICS,
  ...TIER_5_TOPICS,
  ...TIER_6_TOPICS,
];

export const TOPICS_BY_ID: Record<string, ResearchTopic> = (() => {
  const m: Record<string, ResearchTopic> = {};
  for (const t of ALL_TOPICS) m[t.id] = t;
  return m;
})();

export interface ResearchState {
  /** Topic id currently being studied, or null if no topic is active.
   * The system auto-picks the next available topic; the player has no
   * control here yet (an "assign topic" UI lands later). */
  current: string | null;
  /** Accumulated ticks of study toward `current`. Reset to 0 on
   * completion or topic switch. */
  progress: number;
  /** Topic ids that have been fully researched. */
  completed: string[];
}

export function defaultResearch(): ResearchState {
  return { current: null, progress: 0, completed: [] };
}

/** Context the research selector consults to decide what's
 * available right now. Stockpile counters drive resource gates;
 * the discoveries set drives tile gates. Both are read-only here. */
export interface ResearchAvailabilityContext {
  /** Cumulative haul totals — once a counter has crossed a gate's
   * `min`, the gate stays open. The current spendable amount in the
   * stockpile is irrelevant. */
  cumulative: Partial<Record<MaterialResource, number>>;
  /** Tile types the colony has discovered (mined or seen). */
  discovered: ReadonlySet<number>;
}

/** True if every material gate on a topic is satisfied by the
 * given availability context. Topics with no `materials` always
 * pass. Multiple gates AND together. The gem-tile group is special:
 * any of RawDiamond / RawRuby / RawEmerald counts as "a gem vein
 * discovered" so the colony doesn't have to find every kind. */
export function hasMaterials(t: ResearchTopic, ctx: ResearchAvailabilityContext): boolean {
  if (!t.materials || t.materials.length === 0) return true;
  for (const gate of t.materials) {
    if (gate.resource && gate.min !== undefined) {
      const have = ctx.cumulative[gate.resource] ?? 0;
      if (have < gate.min) return false;
    }
    if (gate.tile !== undefined) {
      // Gem topics: any rough-gem tile satisfies "a gem vein". The
      // 21..23 inclusive range covers RawDiamond / RawRuby /
      // RawEmerald in tiles.ts. Other tile gates require an exact
      // tile-type match.
      if (gate.tile === 21) {
        if (!ctx.discovered.has(21) && !ctx.discovered.has(22) && !ctx.discovered.has(23)) return false;
      } else if (!ctx.discovered.has(gate.tile)) {
        return false;
      }
    }
  }
  return true;
}

/** Return the next topic to study — the cheapest available one whose
 * prerequisites + material gates are all satisfied and that hasn't
 * been finished yet. Deterministic tie-break by id. The optional
 * availability context is used for material gating; omitted = no
 * material gate (back-compat for tests + older callers). */
export function nextTopic(state: ResearchState, ctx?: ResearchAvailabilityContext): ResearchTopic | null {
  const done = new Set(state.completed);
  let best: ResearchTopic | null = null;
  for (const t of ALL_TOPICS) {
    if (done.has(t.id)) continue;
    if (!t.prereqs.every((p) => done.has(p))) continue;
    if (ctx && !hasMaterials(t, ctx)) continue;
    if (
      !best ||
      t.cost < best.cost ||
      (t.cost === best.cost && t.id < best.id)
    ) {
      best = t;
    }
  }
  return best;
}
