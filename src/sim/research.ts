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

export interface ResearchTopic {
  id: string;
  name: string;
  tier: ResearchTier;
  /** Total scholarship-ticks required to complete. */
  cost: number;
  /** Topic ids that must be complete before this one becomes available. */
  prereqs: string[];
}

/** GDD Tier 1 — Craft Fundamentals. All available from game start. */
export const TIER_1_TOPICS: ResearchTopic[] = [
  { id: "basic_stonecutting", name: "Basic Stonecutting", tier: 1, cost: 600, prereqs: [] },
  { id: "basic_carpentry", name: "Basic Carpentry", tier: 1, cost: 600, prereqs: [] },
  { id: "iron_smelting", name: "Iron Smelting", tier: 1, cost: 800, prereqs: [] },
  { id: "iron_toolmaking", name: "Iron Toolmaking", tier: 1, cost: 800, prereqs: ["iron_smelting"] },
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
];

export const ALL_TOPICS: ResearchTopic[] = [...TIER_1_TOPICS, ...TIER_2_TOPICS];

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

/** Return the next topic to study — the cheapest available one whose
 * prerequisites are all complete and that hasn't been finished yet.
 * Deterministic tie-break by id. */
export function nextTopic(state: ResearchState): ResearchTopic | null {
  const done = new Set(state.completed);
  let best: ResearchTopic | null = null;
  for (const t of ALL_TOPICS) {
    if (done.has(t.id)) continue;
    if (!t.prereqs.every((p) => done.has(p))) continue;
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
