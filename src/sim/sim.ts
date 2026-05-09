import { SimWorld } from "./world/simWorld";
import { chooseTask } from "./jobs/chooseTask";
import { TileType } from "./world/tiles";
import { unpackCell } from "./pathing/astar";
import { JobAssignment, Pathing } from "./ecs/components";
import { EntityId } from "./ecs/world";
import { narrateOreFirstStrike, narrateDeath, narratePairing, narrateBirth, narrateBereavement, narrateHostileSpawn, narrateHostileSlain, narrateArrival } from "./events/narrator";
import { TICKS_PER_YEAR, TICKS_PER_DAY } from "./time";
import { inheritTraits, newbornSkills, rollChildName } from "./dwarves/birth";
import { generateFounder } from "./dwarves/founders";
import { levelFromXp } from "./dwarves/skillProgress";
import { skillTier, skillTierLabel, SKILLS_BY_ID, SkillId } from "./dwarves/skills";
import { HOSTILE_DEFS, HostileKind } from "./hostiles/types";
import { ALARM_DURATION_TICKS, ALARM_COOLDOWN_TICKS } from "./emergency";
import { recipeFor } from "./planner/recipes";
import { effectsFor } from "./dwarves/traitEffects";
import { nextTopic, TOPICS_BY_ID } from "./research";

// One in-game minute = MOVE_TICKS to step one tile, MINE_TICKS to break a tile.
// Tuning is intentionally fast for early sessions so behavior is visible.
export const MOVE_TICKS = 1;
export const MINE_TICKS = 6;
export const SLEEP_TICKS = 240; // 4 in-game hours of rest restores 80 sleep
export const SOCIALISE_TICKS = 30; // half an in-game hour of conversation
export const WANDER_LINGER_TICKS = 12; // after arrival, pause briefly before next task

// Need decay rates: units lost per tick. Stored as 1/RATE so we can use the
// per-need accumulator pattern without floating-point determinism worries.
const SLEEP_DECAY_TICKS_PER_UNIT = 30;  // 100 → 0 over ~3000 ticks (~50h)
const SOCIAL_DECAY_TICKS_PER_UNIT = 60; // 100 → 0 over ~6000 ticks (~100h)
// Hunger and thirst are the real survival pressures: thirst decays fastest
// (hits 0 in ~24 in-game hours), hunger second-fastest (~48h). Numbers tuned
// so a healthy adult in a stocked colony eats / drinks roughly daily.
const HUNGER_DECAY_TICKS_PER_UNIT = 30; // 100 → 0 over ~3000 ticks (~50h)
const THIRST_DECAY_TICKS_PER_UNIT = 15; // 100 → 0 over ~1500 ticks (~25h)
export const EAT_TICKS = 30;
export const DRINK_TICKS = 18;

/**
 * Single deterministic tick. Used by both the main thread game loop and the
 * catch-up worker — the only difference between live play and catch-up is
 * whether a renderer reads the world after the tick.
 */
export function tick(sim: SimWorld): void {
  sim.tick++;
  // Order matters for determinism. Each system iterates entities via sparse-set
  // dense arrays so iteration order is deterministic.
  sim.planner.tick({
    grid: sim.grid,
    spawn: sim.spawn,
    tick: sim.tick,
    population: sim.dwarf.size(),
    rng: sim.plannerRng,
    events: sim.events,
    research: { completed: sim.research.completed },
    aquiferBreached: sim.aquiferBreachTick >= 0,
  });
  yearRolloverSystem(sim);
  emergencySystem(sim);
  researchPickSystem(sim);
  draftSystem(sim);
  pairingSystem(sim);
  reproductionSystem(sim);
  migrationSystem(sim);
  populationMilestoneSystem(sim);
  deathSystem(sim);
  needsSystem(sim);
  jobAssignmentSystem(sim);
  movementSystem(sim);
  workSystem(sim);
  hostileSpawnSystem(sim);
  hostileMovementSystem(sim);
  combatSystem(sim);
  healingSystem(sim);
  farmSystem(sim);
  tradeSystem(sim);
  hollowKingSystem(sim);
  hollowKingManifestSystem(sim);
  specialTraitSystem(sim);
  furyEndSystem(sim);
  floodSystem(sim);
  depthMilestoneSystem(sim);
  plannerMilestoneSystem(sim);
  visibilitySystem(sim);
}

// ---- Special traits (GDD §6.5) ---------------------------------------
//
// Most traits are folded into numerical modifiers via traitEffects,
// but a handful of "special" traits — flagged rare in the GDD — fire
// flavour events instead of changing damage / speed numbers.
// Stone-Speaker senses ore veins, Ancestor's Voice delivers advice
// from beyond, and The Fury triggers a berserk rage when a bonded
// dwarf is slain. Each runs on its own cadence and writes to the
// chronicle in the dwarf's voice.

const STONE_SPEAKER_INTERVAL = TICKS_PER_DAY * 6; // once per season
const ANCESTOR_VOICE_INTERVAL = TICKS_PER_DAY * 7; // once per in-game week
const STONE_SPEAKER_RANGE = 200;

function specialTraitSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % STONE_SPEAKER_INTERVAL === 0) {
    // For each Stone-Speaker, find the nearest still-unseen valuable
    // tile within range and write a vision line in their voice.
    for (const id of sim.dwarf.entities) {
      const dw = sim.dwarf.get(id);
      if (!dw || !dw.traitIds.includes("stone_speaker")) continue;
      const pos = sim.position.get(id);
      if (!pos) continue;
      const find = findUnseenValuableTile(sim, pos.x, pos.y, STONE_SPEAKER_RANGE);
      if (!find) continue;
      const dy = find.y - sim.spawn.y;
      const where = dy < 80 ? "in the upper rock"
        : dy < 300 ? "in the shallow earth"
        : dy < 700 ? "deep in the granite"
        : dy < 1200 ? "at the gem seam"
        : "in the ancient dark";
      sim.events.add(
        sim.tick,
        "discovery",
        `${dw.name} closes their eyes and listens. They say there is ${find.kindLabel} ${where}, ${dy} tiles down.`,
      );
    }
  }
  if (sim.tick % ANCESTOR_VOICE_INTERVAL === 0) {
    // Each Ancestor's-Voice dwarf hears one piece of dwarven wisdom.
    for (const id of sim.dwarf.entities) {
      const dw = sim.dwarf.get(id);
      if (!dw || !dw.traitIds.includes("ancestors_voice")) continue;
      const advice = ANCESTOR_ADVICE[sim.aiRng.nextRange(0, ANCESTOR_ADVICE.length)];
      sim.events.add(
        sim.tick,
        "social",
        `${dw.name} hears their grandmother's voice from somewhere behind the stone. "${advice}"`,
      );
    }
  }
}

const ANCESTOR_ADVICE: string[] = [
  "Mind the water. Stone forgets a great many things, but never water.",
  "A dwarf without a friend is a dwarf without a fortress.",
  "The deep rock keeps better counsel than any king.",
  "Sharpen a tool twice and use it once.",
  "Ale is a kind of architecture.",
  "Do not climb stairs while angry.",
  "Three things should never be done in haste: a marriage, a tunnel, and a meal.",
  "Listen to the new arrivals. They have walked roads we have forgotten.",
];

interface UnseenValuable { x: number; y: number; kindLabel: string }

function findUnseenValuableTile(sim: SimWorld, sx: number, sy: number, range: number): UnseenValuable | null {
  const grid = sim.grid;
  let best: UnseenValuable & { d: number } | null = null;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const d = dx * dx + dy * dy;
      if (d > range * range) continue;
      const x = sx + dx;
      const y = sy + dy;
      if (!grid.inBounds(x, y)) continue;
      if (grid.isSeen(x, y)) continue;
      const t = grid.getTile(x, y);
      let label: string | null = null;
      if (t === TileType.Ore) label = "an ore vein";
      else if (t === TileType.Silver) label = "a silver vein";
      else if (t === TileType.RawDiamond) label = "a diamond cluster";
      else if (t === TileType.RawRuby) label = "a ruby cluster";
      else if (t === TileType.RawEmerald) label = "an emerald cluster";
      else if (t === TileType.Adamantite) label = "adamantite, deep down";
      else if (t === TileType.VoidOre) label = "void-ore in the dark";
      if (!label) continue;
      if (!best || d < best.d) {
        best = { x, y, kindLabel: label, d };
      }
    }
  }
  return best ? { x: best.x, y: best.y, kindLabel: best.kindLabel } : null;
}

/** Once a Furious dwarf has no hostile within engage range, the rage
 * drains and they collapse exhausted. The trait is consumed (the
 * GDD's "once per lifetime" rule); the marker stays on the dwarf so
 * it can never re-trigger. */
function furyEndSystem(sim: SimWorld): void {
  const ents = sim.fury.entities.slice();
  for (const id of ents) {
    const pos = sim.position.get(id);
    if (!pos) {
      sim.fury.remove(id);
      continue;
    }
    let hostileNearby = false;
    const hEnts = sim.hostile.entities;
    for (let i = 0; i < hEnts.length; i++) {
      const hp = sim.position.get(hEnts[i]);
      if (!hp) continue;
      const dx = hp.x - pos.x;
      const dy = hp.y - pos.y;
      if (dx * dx + dy * dy <= 16 * 16) { hostileNearby = true; break; }
    }
    if (hostileNearby) continue;
    // Rage drains. Mark the trait used so a second bereavement can't
    // re-fire it.
    const f = sim.fury.get(id);
    if (f && !f.used) {
      const dw = sim.dwarf.get(id);
      sim.events.add(
        sim.tick,
        "crisis",
        `${dw?.name ?? "Someone"} stops walking. They look around as if surprised to be alive, and sit down where they stand.`,
      );
      f.used = true;
    }
    sim.fury.remove(id);
  }
}

// ---- Aquifer flooding (GDD §5.2) -------------------------------------
//
// Once an aquifer is breached, water spreads from the source into
// adjacent walkable cells over the following in-game days. The spread
// is capped (a real aquifer doesn't drown the entire fortress; only the
// rooms next to the breach). Once the colony has lived through a week
// without dying out, the Aquifer Survived milestone fires.

const FLOOD_TICK_INTERVAL = 30; // try a spread step every half in-game hour
const FLOOD_MAX_TILES = 60; // cap the total water tiles spawned per breach
const AQUIFER_SURVIVED_TICKS = 24 * 60 * 7; // a week of in-game time
const FLOOD_DX = [1, -1, 0, 0];
const FLOOD_DY = [0, 0, 1, -1];

function floodSystem(sim: SimWorld): void {
  if (sim.aquiferBreachTick < 0) return;
  if (sim.tick % FLOOD_TICK_INTERVAL !== 0) return;
  const grid = sim.grid;
  // Count current water and pick a random water tile to spread from.
  // For determinism we pick by aiRng over the candidate list.
  let waterCount = 0;
  type Cell = { x: number; y: number };
  const sources: Cell[] = [];
  // Sample only the visible viewport — at full world size scanning
  // every tile is wasteful. The flood started at the breach tile; we
  // walk outward along seen tiles.
  // Cheaper: scan the full grid once but cap the work.
  const w = grid.width;
  const h = grid.height;
  for (let y = 0; y < h && waterCount <= FLOOD_MAX_TILES; y++) {
    for (let x = 0; x < w && waterCount <= FLOOD_MAX_TILES; x++) {
      if (grid.getTile(x, y) === TileType.Water) {
        waterCount++;
        sources.push({ x, y });
      }
    }
  }
  if (waterCount >= FLOOD_MAX_TILES) {
    // Saturation reached. Flood holds at this footprint until the
    // Survived milestone fires.
    if (sim.tick - sim.aquiferBreachTick >= AQUIFER_SURVIVED_TICKS && sim.dwarf.size() > 0) {
      fireMilestone(
        sim,
        "the_aquifer_survived",
        "The Aquifer Survived. The flood has stopped rising. The colony stands above the waterline.",
      );
    }
    return;
  }
  // Pick a deterministic source and try to spread to one of its
  // walkable neighbours.
  if (sources.length === 0) return;
  const src = sources[sim.aiRng.nextRange(0, sources.length)];
  const order = sim.aiRng.nextRange(0, 4);
  for (let i = 0; i < 4; i++) {
    const k = (order + i) % 4;
    const nx = src.x + FLOOD_DX[k];
    const ny = src.y + FLOOD_DY[k];
    if (!grid.inBounds(nx, ny)) continue;
    if (!grid.isWalkable(nx, ny)) continue;
    grid.setTile(nx, ny, TileType.Water);
    return;
  }
  // Source had no spread targets — happens if the breach tile is
  // already surrounded by stone. Wait for the next pick.
  if (sim.tick - sim.aquiferBreachTick >= AQUIFER_SURVIVED_TICKS && sim.dwarf.size() > 0) {
    fireMilestone(
      sim,
      "the_aquifer_survived",
      "The Aquifer Survived. The flood found nowhere to spread. The colony stands above the waterline.",
    );
  }
}

// ---- Hollow King arc (GDD §9.4) --------------------------------------
//
// When the first dwarf stands at depth ≥ 1601 the Hollow King becomes
// aware of the colony. Awareness is one-shot — a moment in the
// chronicle. Once awake the King's influence builds: every few
// in-game days a Void-Sensitive dwarf (or any dwarf, if there are
// none) records a nightmare in the event log. The full siege arc —
// dwarves carving symbols in their sleep, the sustained campaign —
// lands when the cosmology systems catch up; this commit ships the
// awakening + the slow drumbeat of dread.

const NIGHTMARE_INTERVAL_TICKS = TICKS_PER_DAY * 3;
const HOLLOW_KING_DEPTH = 1601;
/** Once this many nightmares have been recorded the King's emissaries
 * begin to slip into the colony. Tuned to roughly two in-game weeks
 * (~14 nightmares × 3 days each = ~42 days). */
const HOLLOW_KING_SIEGE_THRESHOLD = 14;
/** Real time between successive void-shade arrivals once the siege
 * phase begins. */
const HOLLOW_KING_SIEGE_INTERVAL_TICKS = TICKS_PER_DAY * 4;
/** How many shades show up at once. Three is a meaningful fight for a
 * mid-game military but not auto-fatal for a prepared one. */
const HOLLOW_KING_SHADES_PER_SIEGE = 3;
/** Cumulative void-shade kills the colony needs to fire The Siege
 * Endured milestone. Defeating the King himself is reserved for
 * actually putting the hollow_king hostile down. With three shades
 * per siege every four in-game days, twenty kills represents
 * surviving roughly a season of sustained attacks. */
const HOLLOW_KING_VICTORY_THRESHOLD = 20;

function hollowKingSystem(sim: SimWorld): void {
  if (!sim.hollowKingAware) {
    let reached = false;
    sim.forEachDwarf((_id, p) => {
      if (reached) return;
      if (p.y - sim.spawn.y >= HOLLOW_KING_DEPTH) reached = true;
    });
    if (reached) {
      sim.hollowKingAware = true;
      sim.events.add(
        sim.tick,
        "crisis",
        "Something deep beneath the stone has noticed the colony. The dwarves at the deepest face go quiet for a long minute.",
      );
      fireMilestone(
        sim,
        "voice_in_the_stone",
        "Voice in the Stone. The Hollow King is awake to the colony's presence.",
      );
    }
    return;
  }
  // Phase 1: dread + nightmares.
  if (sim.tick > 0 && sim.tick % NIGHTMARE_INTERVAL_TICKS === 0) {
    deliverNightmare(sim);
    sim.hollowKingNightmares++;
    // First-siege herald: announce the shift in tone before the first
    // shade actually arrives.
    if (sim.hollowKingNightmares === HOLLOW_KING_SIEGE_THRESHOLD) {
      sim.events.add(
        sim.tick,
        "crisis",
        "The dreams stop. Across the fortress, every dwarf knows something is about to be sent.",
      );
      sim.hollowKingLastSiegeTick = sim.tick;
    }
  }
  // Phase 2: siege. Periodically spawn a clutch of void shades inside
  // the colony's reachable space.
  if (sim.hollowKingNightmares < HOLLOW_KING_SIEGE_THRESHOLD) return;
  if (sim.tick - sim.hollowKingLastSiegeTick < HOLLOW_KING_SIEGE_INTERVAL_TICKS) return;
  if (sim.tick === 0) return;
  spawnVoidShadeSiege(sim);
  sim.hollowKingLastSiegeTick = sim.tick;
}

/** Phase 3: the King himself. Once the colony researches "The King's
 * Name" (Tier 6), the King manifests as a hostile entity — only then
 * can he be brought down. One-shot per fortress: hollowKingSpawned
 * latches true so a re-load doesn't summon a second King. */
function hollowKingManifestSystem(sim: SimWorld): void {
  if (sim.hollowKingSpawned) return;
  if (!sim.research.completed.includes("the_kings_name")) return;
  if (!sim.hollowKingAware) return;
  // Place him at the deepest reachable Underworld tile, away from the
  // dwarves so the colony has to march out and find him.
  const reachable = sim.planner.exposeReachable(sim);
  if (!reachable) return;
  const grid = sim.grid;
  const w = grid.width;
  let candidate: { x: number; y: number } | null = null;
  let candidateY = -1;
  for (let i = 0; i < reachable.length; i++) {
    if (reachable[i] !== 1) continue;
    const y = (i / w) | 0;
    if (y - sim.spawn.y < HOLLOW_KING_DEPTH) continue;
    if (y > candidateY) {
      candidateY = y;
      candidate = { x: i % w, y };
    }
  }
  if (!candidate) return;
  sim.spawnHostile({ kind: "hollow_king", x: candidate.x, y: candidate.y });
  sim.hollowKingSpawned = true;
  sim.events.add(
    sim.tick,
    "crisis",
    "The scholars speak the King's true name. Far below, something colossal stands up out of the dark to answer.",
  );
}

function deliverNightmare(sim: SimWorld): void {
  // Pick a dreamer — prefer Void-Sensitive, else Dream-Touched, else any.
  const ents = sim.dwarf.entities;
  let dreamer: EntityId | null = null;
  for (const id of ents) {
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    if (dw.traitIds.includes("void_sensitive")) { dreamer = id; break; }
  }
  if (dreamer === null) {
    for (const id of ents) {
      const dw = sim.dwarf.get(id);
      if (!dw) continue;
      if (dw.traitIds.includes("dream_touched")) { dreamer = id; break; }
    }
  }
  if (dreamer === null && ents.length > 0) {
    dreamer = ents[sim.aiRng.nextRange(0, ents.length)];
  }
  if (dreamer === null) return;
  const dw = sim.dwarf.get(dreamer);
  if (!dw) return;
  const dreams = [
    `${dw.name} dreams of a great hollow eye opening in the dark.`,
    `${dw.name} wakes shouting. They will not say what they saw.`,
    `${dw.name} carves a symbol into the wall in their sleep, then weeps to find it.`,
    `${dw.name} dreams of a name that cannot be spoken aloud.`,
    `${dw.name} stands at the deepest face for an hour, listening to nothing in particular.`,
  ];
  const text = dreams[sim.aiRng.nextRange(0, dreams.length)];
  sim.events.add(sim.tick, "crisis", text);
}

function spawnVoidShadeSiege(sim: SimWorld): void {
  const reachable = sim.planner.exposeReachable(sim);
  if (!reachable) return;
  const grid = sim.grid;
  const w = grid.width;
  // Collect deep reachable tiles as candidate spawn points. The King's
  // shades emerge from the depths, not the surface.
  const candidates: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < reachable.length; i++) {
    if (reachable[i] !== 1) continue;
    const y = (i / w) | 0;
    if (y - sim.spawn.y < 60) continue;
    const x = i % w;
    let tooClose = false;
    sim.forEachDwarf((_id, p) => {
      if (tooClose) return;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < 36) tooClose = true;
    });
    if (!tooClose) candidates.push({ x, y });
  }
  if (candidates.length === 0) return;
  const spawned: Array<{ x: number; y: number }> = [];
  for (let n = 0; n < HOLLOW_KING_SHADES_PER_SIEGE; n++) {
    const pick = candidates[sim.aiRng.nextRange(0, candidates.length)];
    sim.spawnHostile({ kind: "void_shade", x: pick.x, y: pick.y });
    spawned.push(pick);
  }
  sim.events.add(
    sim.tick,
    "crisis",
    `${spawned.length} void shades have stepped out of the dark within the fortress. The Hollow King is testing the gates.`,
  );
}

/** Friendly depth phrasing — used by gem-strike narration. Mirrors the
 * helper in events/narrator.ts, kept local to avoid a circular import. */
function depthPhraseFor(y: number, surfaceY: number): string {
  const depth = y - surfaceY;
  if (depth < 80) return "in the upper rock";
  if (depth < 300) return "in the shallow earth";
  if (depth < 700) return "deep in the granite";
  if (depth < 1200) return "in the gem seam";
  return "in the ancient dark";
}

// ---- Trade caravans (GDD §8.3) ---------------------------------------
//
// Once per in-game season a caravan arrives at the colony's Trade Depot
// (if one exists). The deal is computed from the colony's needs — short
// on food, the caravan brings food; short on drink, it brings drink;
// otherwise the caravan trades for tools to seed future production.
// Stone is the currency (the colony has plenty after digging). Lockdown
// blocks caravans entirely. The Trading skill of the dwarf with the
// highest skill level acts as the broker — they get the XP and a small
// bonus to the deal.

const TRADE_INTERVAL_TICKS = TICKS_PER_DAY * 6; // four caravans per in-game year
const TRADE_BASE_COST = 30;
const TRADE_BASE_GAIN = 50;

function tradeSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TRADE_INTERVAL_TICKS !== 0) return;
  if (sim.emergency.mode === "lockdown") return;
  // Need an active Trade Depot.
  let hasDepot = false;
  for (const b of sim.planner.blueprints) {
    if (b.kind === "trade_depot" && b.status === "complete") {
      hasDepot = true;
      break;
    }
  }
  if (!hasDepot) return;
  // Need stone to trade.
  if (sim.stockpile.stone < TRADE_BASE_COST) {
    sim.events.add(
      sim.tick,
      "social",
      "A caravan arrives, but the colony has no stone to trade. They depart empty-handed.",
    );
    return;
  }
  // Pick the broker — best Trading skill, tie-break by entity id.
  let bestBroker = -1;
  let bestSkill = -1;
  for (const id of sim.dwarf.entities) {
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const skill = dw.skills.trading ?? 1;
    if (skill > bestSkill || (skill === bestSkill && id < bestBroker)) {
      bestBroker = id;
      bestSkill = skill;
    }
  }
  // Decide the deal based on the colony's lowest-stocked food / drink.
  const foodLow = sim.stockpile.food < 200;
  const drinkLow = sim.stockpile.drink < 200;
  let kind: "food" | "drink" | "tools";
  if (foodLow && (!drinkLow || sim.stockpile.food <= sim.stockpile.drink)) kind = "food";
  else if (drinkLow) kind = "drink";
  else kind = "tools";
  // Broker bonus: each level above 1 adds 4% to the gain.
  const brokerBonus = 1 + Math.max(0, bestSkill - 1) * 0.04;
  const gain = Math.round(TRADE_BASE_GAIN * brokerBonus);
  sim.stockpile.stone -= TRADE_BASE_COST;
  sim.stockpile[kind] += gain;
  // Award XP to the broker.
  if (bestBroker !== -1) awardSkillXp(sim, bestBroker, "trading", 1);
  const brokerName = bestBroker !== -1 ? sim.dwarf.get(bestBroker)?.name ?? "the broker" : "the broker";
  sim.events.add(
    sim.tick,
    "social",
    `A caravan from the western kingdoms arrives at the Trade Depot. ${brokerName} negotiates ${gain} ${kind} for ${TRADE_BASE_COST} stone.`,
  );
}

// ---- Research auto-pick -----------------------------------------------
//
// If no topic is currently being studied, pick the cheapest available
// one whose prerequisites are met. Auto-pick runs every tick (cheap)
// so a freshly-completed topic immediately yields the next one.

function researchPickSystem(sim: SimWorld): void {
  if (sim.research.current) return;
  const next = nextTopic(sim.research);
  if (!next) return;
  sim.research.current = next.id;
  sim.research.progress = 0;
  sim.events.add(
    sim.tick,
    "milestone",
    `The scholars open a new line of inquiry: ${next.name}.`,
  );
}

// ---- Military draft ----------------------------------------------------
//
// Once per in-game year the colony picks its standing military: the top
// fraction of adults by Military skill get a Squad component, marking
// them as soldiers. Soldiers chase hostiles on sight (engage job),
// answer the Alarm by mustering at the entrance, and deal a flat damage
// bonus in melee.
//
// The fraction is intentionally small — five soldiers in a fifty-dwarf
// colony, a dozen in a fortress of two hundred. The rest of the
// population stays civilian and runs the workshops, farms, and library.

const DRAFT_FRACTION = 0.1;
const DRAFT_MIN_AGE = 18;
const DRAFT_MIN_MILITARY_SKILL = 2;

function draftSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  // Gather eligible adults sorted by Military skill descending; tie-break by
  // entity id for determinism.
  type Cand = { id: EntityId; military: number };
  const eligible: Cand[] = [];
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    if (sim.ageOf(id) < DRAFT_MIN_AGE) continue;
    const military = dw.skills.military ?? 1;
    if (military < DRAFT_MIN_MILITARY_SKILL) continue;
    eligible.push({ id, military });
  }
  eligible.sort((a, b) => (b.military - a.military) || (a.id - b.id));
  const target = Math.max(1, Math.ceil(sim.dwarf.size() * DRAFT_FRACTION));
  const keep = new Set<EntityId>();
  for (let i = 0; i < Math.min(target, eligible.length); i++) {
    const c = eligible[i];
    keep.add(c.id);
    if (!sim.squad.has(c.id)) {
      sim.squad.set(c.id, { draftedAtTick: sim.tick });
      const dw = sim.dwarf.get(c.id);
      if (dw) {
        sim.events.add(
          sim.tick,
          "social",
          `${dw.name} has been drafted into the colony's standing guard.`,
        );
      }
    }
    // Equip the soldier. Two supply lines:
    //   1. A tool item sitting on an Armoury rack (the GDD-aligned
    //      flow — a hauler delivered it from a forge).
    //   2. The global sim.stockpile.tools counter (fallback for
    //      colonies without an Armoury yet, or whose haulers haven't
    //      caught up).
    if (!sim.equipment.has(c.id)) {
      let armed = false;
      // Look for a tool on a rack.
      const ents = sim.item.entities;
      for (let i = 0; i < ents.length && !armed; i++) {
        const ie = ents[i];
        const it = sim.item.get(ie);
        const p = sim.position.get(ie);
        if (!it || !p) continue;
        if (it.kind !== "tools") continue;
        if (sim.grid.getTile(p.x, p.y) !== TileType.ArmouryRack) continue;
        sim.destroyItem(ie);
        armed = true;
      }
      if (!armed && sim.stockpile.tools > 0) {
        sim.stockpile.tools--;
        armed = true;
      }
      if (armed) {
        sim.equipment.set(c.id, { weapon: true });
        const dw = sim.dwarf.get(c.id);
        if (dw) {
          sim.events.add(
            sim.tick,
            "social",
            `${dw.name} draws a forged tool from the armoury — a weapon now, not a pickaxe.`,
          );
        }
      }
    }
  }
  // Anyone in the squad component but no longer in the keep set is
  // demobilised. Mostly happens when population shrinks past the cap.
  // Equipment stays with the dwarf — they keep the weapon for life.
  const sEnts = sim.squad.entities.slice();
  for (const id of sEnts) {
    if (!keep.has(id)) {
      sim.squad.remove(id);
    }
  }

  // Legends of the Deep (GDD §10.2): the colony has fielded a squad
  // where every soldier has at least one Legendary skill (level ≥ 17).
  // Requires at least three soldiers — a single legendary lone-wolf
  // shouldn't trigger the milestone.
  const finalSquad = sim.squad.entities;
  if (finalSquad.length >= 3) {
    let allLegendary = true;
    for (const id of finalSquad) {
      const dw = sim.dwarf.get(id);
      if (!dw) { allLegendary = false; break; }
      let hasLegendary = false;
      for (const lvl of Object.values(dw.skills)) {
        if ((lvl ?? 0) >= 17) { hasLegendary = true; break; }
      }
      if (!hasLegendary) { allLegendary = false; break; }
    }
    if (allLegendary) {
      fireMilestone(
        sim,
        "legends_of_the_deep",
        "Legends of the Deep. Every soldier in the standing guard has reached Legendary in at least one skill.",
      );
    }
  }
}

// ---- Emergency state machine ------------------------------------------
//
// Auto-cancels Alarm after one in-game hour and writes the cooldown.
// Evacuate and Lockdown only end on player input.

function emergencySystem(sim: SimWorld): void {
  const e = sim.emergency;
  if (e.mode === "alarm" && sim.tick - e.startedAtTick >= ALARM_DURATION_TICKS) {
    e.mode = "none";
    e.alarmCooldownUntil = sim.tick + ALARM_COOLDOWN_TICKS;
    sim.events.add(sim.tick, "crisis", "The alarm has been lifted. The fortress returns to its work.");
  }
}

// ---- Narrative milestones (GDD §10.2) ---------------------------------
//
// One-shot announcements that mark a fortress's history: the first
// hearth lit, the first bar smelted, the first diamond struck, the
// first time a dwarf stands in the Gem Seam or the Ancient Dark. Each
// is gated by a string id stored in sim.narrativeMilestones so reloads
// don't replay them.

function fireMilestone(sim: SimWorld, id: string, text: string): void {
  if (sim.narrativeMilestones.has(id)) return;
  sim.narrativeMilestones.add(id);
  sim.events.add(sim.tick, "milestone", text);
}

/** Idempotent check for milestones gated on planner state — currently
 * just the Grand Citadel (throne room exists and is complete). Cheap,
 * runs every tick, the first qualifying state fires the milestone and
 * subsequent ticks no-op via the narrativeMilestones set. */
function plannerMilestoneSystem(sim: SimWorld): void {
  for (const b of sim.planner.blueprints) {
    if (b.kind === "throne_room" && b.status === "complete") {
      fireMilestone(
        sim,
        "the_grand_citadel",
        "The Grand Citadel. The throne room is finished — the colony has its hall.",
      );
      return;
    }
  }
}

/** Watch the deepest dwarf and fire layer-crossing milestones the
 * first time the colony's deepest reach lands in each layer band. */
function depthMilestoneSystem(sim: SimWorld): void {
  let deepest = sim.spawn.y;
  sim.forEachDwarf((_id, p) => {
    if (p.y > deepest) deepest = p.y;
  });
  const depth = deepest - sim.spawn.y;
  if (depth >= 700) {
    fireMilestone(
      sim,
      "the_gem_seam",
      "The Gem Seam. The colony has reached the gem seam — the deepest face glints unfamiliar colours.",
    );
  }
  if (depth >= 1200) {
    fireMilestone(
      sim,
      "the_ancient_dark",
      "The Ancient Dark. The dwarves stand in the layer the old songs warned them about.",
    );
  }
}

// ---- Visibility / fog of war ------------------------------------------
//
// Each dwarf reveals a square of tiles around them every tick. Reveal is
// monotonic (once seen, always seen) — caves you've been in stay drawn
// after you leave. Solid rock the dwarves haven't reached stays opaque
// black so the cross-section feels like a discovery view.

const VISIBILITY_RADIUS = 5;

function visibilitySystem(sim: SimWorld): void {
  const grid = sim.grid;
  const dwarves = sim.dwarf.entities;
  for (let i = 0; i < dwarves.length; i++) {
    const pos = sim.position.get(dwarves[i]);
    if (!pos) continue;
    const r = VISIBILITY_RADIUS;
    const x0 = Math.max(0, pos.x - r);
    const y0 = Math.max(0, pos.y - r);
    const x1 = Math.min(grid.width - 1, pos.x + r);
    const y1 = Math.min(grid.height - 1, pos.y + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - pos.x;
        const dy = y - pos.y;
        if (dx * dx + dy * dy <= r * r) grid.markSeen(x, y);
      }
    }
  }
}

// ---- Farms -------------------------------------------------------------
// Each FarmTile in the world has a small chance, every in-game hour, of
// contributing one unit of food to the stockpile. Tuned so a single 4×3
// farm (12 cells) yields roughly 30 food per in-game day at steady state
// — enough to feed a 7-dwarf colony with margin. Hauling and explicit
// plant/harvest jobs land in a later session; for now the food appears
// abstractly on the assumption that the dwarves are tending the plot
// during their "wander" idle time.

const FARM_TICK_INTERVAL = 60; // once per in-game hour
const FARM_YIELD_CHANCE = 0.18; // per-cell, per-hour, for a tended cell
/** Cell counts as "tended" for this many ticks after a dwarf works it.
 * Synced with the chooseTask threshold so the targeting and the yield
 * agree. */
const FARM_TEND_VALIDITY_TICKS = 12 * 60;

/** How many item entities of `kind` are sitting on (x, y). Used to cap
 * stacking so an unattended farm cell doesn't spawn a tower of food. */
function countItemsAt(sim: SimWorld, x: number, y: number, kind: import("./ecs/components").ItemKind): number {
  let n = 0;
  const ents = sim.item.entities;
  for (let i = 0; i < ents.length; i++) {
    const it = sim.item.get(ents[i]);
    const p = sim.position.get(ents[i]);
    if (!it || !p) continue;
    if (p.x === x && p.y === y && it.kind === kind) n++;
  }
  return n;
}

function farmSystem(sim: SimWorld): void {
  if (sim.tick % FARM_TICK_INTERVAL !== 0) return;
  for (const b of sim.planner.blueprints) {
    if (b.kind !== "farm") continue;
    if (b.status !== "complete") continue;
    if (!b.cellTendedAt) continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) !== TileType.FarmTile) continue;
      // Only tended cells produce. Untended cells go fallow until a
      // dwarf returns to work them.
      const tendedAt = b.cellTendedAt[i];
      if (tendedAt < 0 || sim.tick - tendedAt > FARM_TEND_VALIDITY_TICKS) continue;
      if (sim.aiRng.nextFloat() < FARM_YIELD_CHANCE) {
        // Drop a raw food item on the cell. A hauler routes it to a
        // kitchen (cooked meals), brewery (ale), or stockpile in
        // priority order. Cap stacking on a single cell so an
        // un-hauled farm doesn't grow a tower of food entities.
        if (countItemsAt(sim, x, y, "food") < 4) {
          sim.spawnItem({ kind: "food", x, y });
        }
      }
    }
  }
}

// GDD §6.1 lifecycle: death at ~150 years naturally; dwarf-touched extends
// to 250+. Beyond a 20-year warning window the chance increases each year
// until the threshold age is certain. Rolls are seeded RNG so catch-up
// produces the same lifecycle as live play.
const DEFAULT_DEATH_AGE = 150;
const DWARF_TOUCHED_DEATH_AGE = 250;
const DEATH_WARNING_WINDOW_YEARS = 20;

function deathSystem(sim: SimWorld): void {
  // Only check at year boundaries — cheap and matches the calendar grain.
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  if (sim.tick === 0) return; // skip the founding tick
  const ents = sim.dwarf.entities;
  // Iterate backwards so killDwarf can mutate the array as we go.
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dw = sim.dwarf.get(e);
    if (!dw) continue;
    const age = sim.ageOf(e);
    const threshold = dw.traitIds.includes("dwarf_touched")
      ? DWARF_TOUCHED_DEATH_AGE
      : DEFAULT_DEATH_AGE;
    if (age >= threshold) {
      killDwarf(sim, e, "old age");
      continue;
    }
    if (age >= threshold - DEATH_WARNING_WINDOW_YEARS) {
      // Linear ramp from 0% chance at the warning edge to ~50% per year at
      // the threshold itself. Most dwarves succumb within the window.
      const overage = age - (threshold - DEATH_WARNING_WINDOW_YEARS);
      const chance = (overage / DEATH_WARNING_WINDOW_YEARS) * 0.5;
      if (sim.aiRng.nextFloat() < chance) {
        killDwarf(sim, e, "old age");
      }
    }
  }
}

/**
 * Remove a dwarf from the sim, log the death in the chronicle, and place a
 * Memorial tile where they fell. Releases any in-flight job claim so the
 * planner state stays consistent. If the dwarf was bonded, also clears the
 * survivor's partnerId and emits a bereavement event.
 */
function killDwarf(sim: SimWorld, e: EntityId, cause: string): void {
  const dw = sim.dwarf.get(e);
  const pos = sim.position.get(e);
  if (!dw || !pos) return;
  // The Fury (GDD §6.5): once-per-life berserk rage that triggers
  // when a bonded dwarf is killed in combat. Combat-only — death from
  // age, dehydration, or starvation doesn't set the survivor on a
  // war path.
  const violentCause = /slain|gored|torn|crushed|struck/i.test(cause);
  if (violentCause && dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
    const partner = sim.dwarf.get(dw.partnerId);
    if (partner && partner.traitIds.includes("the_fury") && !sim.fury.has(dw.partnerId)) {
      sim.fury.set(dw.partnerId, { startedAtTick: sim.tick, used: false });
      sim.events.add(
        sim.tick,
        "crisis",
        `${partner.name} sees ${dw.name} fall. Something behind their eyes goes still. They do not stop walking forward.`,
      );
    }
  }
  const age = sim.ageOf(e);
  // Free any mining claim before removing the job component.
  const job = sim.job.get(e);
  if (job?.kind === "mine") sim.releaseMineTarget(job.targetX, job.targetY);
  // Memorial on the death tile if it's walkable space (a dwarf in transit
  // through a tunnel; not a solid tile that another dwarf is mining).
  if (sim.grid.isWalkable(pos.x, pos.y)) {
    sim.grid.setTile(pos.x, pos.y, TileType.Memorial);
  }
  sim.events.add(sim.tick, "social", narrateDeath(sim.aiRng, dw.name, dw.profession, age, cause));
  // If this dwarf had a partner, clear the survivor's partnerId and log a
  // bereavement event. The relationship's length is approximated as
  // min(both ages) - 18 (i.e. years they could have been bonded as adults),
  // which is good enough for narration without a per-bond pairedAtTick.
  if (dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
    const partner = sim.dwarf.get(dw.partnerId);
    if (partner) {
      const survivorAge = sim.ageOf(dw.partnerId);
      const yearsTogether = Math.max(0, Math.min(age, survivorAge) - 18);
      sim.events.add(
        sim.tick,
        "social",
        narrateBereavement(sim.aiRng, partner.name, dw.name, yearsTogether),
      );
      partner.partnerId = null;
    }
  }
  // If the dwarf was carrying something, drop it on the death tile so a
  // teammate can finish the haul. Releases any item claim implicitly via
  // the alive-check in findHaulTarget.
  const carrying = sim.carrying.get(e);
  if (carrying) {
    sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y });
  }
  // Remove from the ECS, which strips all component stores.
  sim.ecs.destroy(e, [sim.position, sim.dwarf, sim.pathing, sim.job, sim.needs, sim.health, sim.carrying, sim.squad, sim.equipment, sim.fury]);
}

// ---- Partnership + reproduction ----------------------------------------

const PAIR_MIN_AGE = 18;
const PAIR_MAX_AGE = 70;
const PAIR_CHANCE_PER_YEAR = 0.35;
const REPRODUCE_MIN_AGE = 18;
const REPRODUCE_MAX_AGE = 60;
const REPRODUCE_CHANCE_PER_YEAR = 0.25;

/**
 * Once per in-game year, scan unpaired adults of pair-eligible age and
 * randomly bond pairs. Order is shuffled deterministically via aiRng so
 * pairing isn't dictated by entity creation order.
 */
function pairingSystem(sim: SimWorld): void {
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  if (sim.tick === 0) return;
  const eligible: EntityId[] = [];
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const dw = sim.dwarf.get(e);
    if (!dw) continue;
    if (dw.partnerId !== null) continue;
    const age = sim.ageOf(e);
    if (age < PAIR_MIN_AGE || age > PAIR_MAX_AGE) continue;
    eligible.push(e);
  }
  // Fisher-Yates shuffle using aiRng for deterministic pairing order.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = sim.aiRng.nextRange(0, i + 1);
    const tmp = eligible[i];
    eligible[i] = eligible[j];
    eligible[j] = tmp;
  }
  for (let i = 0; i + 1 < eligible.length; i += 2) {
    if (sim.aiRng.nextFloat() >= PAIR_CHANCE_PER_YEAR) continue;
    const a = eligible[i];
    const b = eligible[i + 1];
    const dwA = sim.dwarf.get(a);
    const dwB = sim.dwarf.get(b);
    if (!dwA || !dwB) continue;
    dwA.partnerId = b;
    dwB.partnerId = a;
    sim.events.add(sim.tick, "social", narratePairing(sim.aiRng, dwA.name, dwB.name));
  }
}

/**
 * Once per in-game year, paired couples within the fertile age window have
 * a chance of producing a child.
 */
function reproductionSystem(sim: SimWorld): void {
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  if (sim.tick === 0) return;
  const visited = new Set<EntityId>();
  // Iterate a snapshot of the dwarf list — births mutate the live list
  // (newborns get appended), and we don't want them participating in this
  // year's roll.
  const ents = sim.dwarf.entities.slice();
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (visited.has(e)) continue;
    const dw = sim.dwarf.get(e);
    if (!dw || dw.partnerId === null) continue;
    if (!sim.ecs.isAlive(dw.partnerId)) continue;
    const partner = sim.dwarf.get(dw.partnerId);
    if (!partner) continue;
    visited.add(e);
    visited.add(dw.partnerId);
    const ageA = sim.ageOf(e);
    const ageB = sim.ageOf(dw.partnerId);
    if (ageA < REPRODUCE_MIN_AGE || ageA > REPRODUCE_MAX_AGE) continue;
    if (ageB < REPRODUCE_MIN_AGE || ageB > REPRODUCE_MAX_AGE) continue;
    if (sim.aiRng.nextFloat() < REPRODUCE_CHANCE_PER_YEAR) {
      birthDwarf(sim, e, dw.partnerId);
    }
  }
}

/**
 * Increment a dwarf's XP in a skill. If the level advances and the new
 * level crosses a tier boundary (Novice → Adequate, etc.), announce it
 * in the chronicle so the player can watch their veterans become legends.
 */
function awardSkillXp(sim: SimWorld, e: EntityId, skill: SkillId, amount: number): void {
  const dw = sim.dwarf.get(e);
  if (!dw) return;
  const oldXp = dw.skillXp[skill] ?? 0;
  const newXp = oldXp + amount;
  dw.skillXp[skill] = newXp;
  const oldLevel = dw.skills[skill] ?? 1;
  const newLevel = levelFromXp(newXp);
  if (newLevel <= oldLevel) return;
  dw.skills[skill] = newLevel;
  if (skillTier(newLevel) !== skillTier(oldLevel)) {
    const tier = skillTierLabel(newLevel);
    const skillName = SKILLS_BY_ID[skill].name;
    sim.events.add(
      sim.tick,
      "milestone",
      `${dw.name} has become a ${tier} ${skillName}.`,
    );
  }
}

// ---- Migration --------------------------------------------------------

const SEASON_TICKS = TICKS_PER_DAY * 6; // 4 seasons per in-game year (≈24 days)

/** Per-population chance of an arrival group landing each season. The
 * curve is intentionally generous early — a young fortress needs hands —
 * and tapers to zero past 200 dwarves so the colony has a soft cap. */
export function migrationChance(pop: number): number {
  if (pop >= 200) return 0;
  if (pop >= 100) return 0.10;
  if (pop >= 50) return 0.30;
  if (pop >= 20) return 0.45;
  return 0.60;
}

/**
 * Once per in-game season, roll for an arrival group. On a hit, 1–4 fully
 * generated adult dwarves spawn at the colony's spawn tile (the founders'
 * chamber, which sits just below the entrance shaft). They go straight
 * into the autonomous loop alongside the existing dwarves — chooseTask
 * does not differentiate by origin.
 */
function migrationSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % SEASON_TICKS !== 0) return;
  // Lockdown blocks immigrants — the GDD's "any immigrant group currently
  // travelling to the fortress cannot enter" rule.
  if (sim.emergency.mode === "lockdown") return;
  const pop = sim.dwarf.size();
  const chance = migrationChance(pop);
  if (chance === 0) return;
  if (sim.aiRng.nextFloat() >= chance) return;

  // 1–4 arrivals per season, weighted toward small groups.
  const r = sim.aiRng.nextFloat();
  const count = r < 0.45 ? 1 : r < 0.80 ? 2 : r < 0.95 ? 3 : 4;

  // Collect existing first names so immigrants don't collide with the locals.
  const used = new Set<string>();
  sim.forEachDwarf((_id, _pos, dw) => used.add(dw.name.split(" ")[0]));

  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const f = generateFounder(sim.aiRng, used);
    used.add(f.name.split(" ")[0]);
    sim.spawnDwarf({
      name: f.name,
      x: sim.spawn.x,
      y: sim.spawn.y,
      traitIds: f.traits.map((t) => t.id),
      skills: f.skills,
      profession: f.profession,
      age: f.age,
    });
    names.push(f.name);
  }
  sim.events.add(sim.tick, "social", narrateArrival(sim.aiRng, names));
  // Population threshold may have just been crossed — let the milestone
  // system fire its event the same tick, not the next year boundary.
  checkPopulationMilestones(sim);
}

function birthDwarf(sim: SimWorld, motherId: EntityId, fatherId: EntityId): void {
  const mother = sim.dwarf.get(motherId);
  const father = sim.dwarf.get(fatherId);
  const motherPos = sim.position.get(motherId);
  if (!mother || !father || !motherPos) return;
  // Collect existing first names so the newborn isn't a duplicate.
  const usedFirsts = new Set<string>();
  sim.forEachDwarf((_id, _pos, dw) => {
    usedFirsts.add(dw.name.split(" ")[0]);
  });
  const childName = rollChildName(sim.aiRng, mother.name, father.name, usedFirsts);
  const traitIds = inheritTraits(sim.aiRng, mother.traitIds, father.traitIds);
  const childId = sim.spawnDwarf({
    name: childName,
    x: motherPos.x,
    y: motherPos.y,
    traitIds,
    skills: newbornSkills(),
    profession: "Child",
    age: 0,
    bornInColony: true,
  });
  void childId;
  sim.events.add(sim.tick, "social", narrateBirth(sim.aiRng, childName, mother.name, father.name));
  // Population milestones (GDD §10.2). One-shot per threshold via Set.
  checkPopulationMilestones(sim);
  // Three Generations (GDD §10.2): a child is born to two parents who
  // were themselves born in the colony — every grandparent of this
  // newborn lived in the fortress.
  if (mother.bornInColony && father.bornInColony) {
    fireMilestone(
      sim,
      "three_generations",
      `Three Generations. ${childName} is the first dwarf born to two in-colony parents — every grandparent lived in the mountain.`,
    );
  }
}

const POPULATION_MILESTONES: Array<{ count: number; text: string }> = [
  { count: 25, text: "The fortress reaches twenty-five dwarves. The mountain echoes." },
  { count: 50, text: "Fifty dwarves now live in the mountain. The corridors run hot with work." },
  { count: 100, text: "A Hundred Beards. The fortress has grown to a hundred dwarves." },
  { count: 200, text: "Two hundred dwarves. The colony is a small kingdom now." },
];

/** Year-boundary check for population milestones. Each threshold fires
 * exactly once over a fortress's lifetime, captured in a Set on SimWorld
 * that round-trips through save. */
function populationMilestoneSystem(sim: SimWorld): void {
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  const pop = sim.dwarf.size();
  for (const m of POPULATION_MILESTONES) {
    if (pop >= m.count && !sim.populationMilestones.has(m.count)) {
      sim.populationMilestones.add(m.count);
      sim.events.add(sim.tick, "milestone", m.text);
    }
  }
}

function checkPopulationMilestones(sim: SimWorld): void {
  // Also called on each birth so the chronicle records the milestone the
  // year the threshold is crossed even between year-boundary checks.
  const pop = sim.dwarf.size();
  for (const m of POPULATION_MILESTONES) {
    if (pop >= m.count && !sim.populationMilestones.has(m.count)) {
      sim.populationMilestones.add(m.count);
      sim.events.add(sim.tick, "milestone", m.text);
    }
  }
}

/**
 * Emit a "Year N begins in the mountain." entry whenever the calendar
 * crosses a year boundary. Cheap: a single integer comparison per tick.
 */
function yearRolloverSystem(sim: SimWorld): void {
  const year = Math.floor(sim.tick / TICKS_PER_YEAR);
  if (year > sim.lastYearAnnounced) {
    sim.lastYearAnnounced = year;
    if (year >= 1) {
      sim.events.add(sim.tick, "milestone", `Year ${year + 1} begins in the mountain.`);
    }
  }
}

/**
 * Decay each dwarf's needs by integer increments per tick. Uses an
 * accumulator on the Needs component so decay rate isn't tied to integer
 * tick counts and stays deterministic.
 */
function needsSystem(sim: SimWorld): void {
  const ents = sim.dwarf.entities;
  // Iterate backwards so killDwarf-from-starvation can mutate the list.
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const n = sim.needs.get(e);
    if (!n) continue;
    const dw = sim.dwarf.get(e);
    const effects = dw ? effectsFor(dw.traitIds) : null;
    // Iron Constitution / Sickly scale how often the accumulator advances.
    // > 1 means slower decay (stronger constitution).
    const decayScale = effects?.needDecay ?? 1;
    n.decayAccumSleep += 1 / decayScale;
    n.decayAccumSocial += 1 / decayScale;
    n.decayAccumHunger += 1 / decayScale;
    n.decayAccumThirst += 1 / decayScale;
    n.decayAccumMorale++;
    if (n.decayAccumSleep >= SLEEP_DECAY_TICKS_PER_UNIT) {
      n.sleep = Math.max(0, n.sleep - 1);
      n.decayAccumSleep -= SLEEP_DECAY_TICKS_PER_UNIT;
    }
    if (n.decayAccumSocial >= SOCIAL_DECAY_TICKS_PER_UNIT) {
      n.social = Math.max(0, n.social - 1);
      n.decayAccumSocial -= SOCIAL_DECAY_TICKS_PER_UNIT;
    }
    if (n.decayAccumHunger >= HUNGER_DECAY_TICKS_PER_UNIT) {
      n.hunger = Math.max(0, n.hunger - 1);
      n.decayAccumHunger -= HUNGER_DECAY_TICKS_PER_UNIT;
    }
    if (n.decayAccumThirst >= THIRST_DECAY_TICKS_PER_UNIT) {
      n.thirst = Math.max(0, n.thirst - 1);
      n.decayAccumThirst -= THIRST_DECAY_TICKS_PER_UNIT;
    }
    // Morale drifts at most 1 unit per in-game hour toward a target derived
    // from the trait baseline plus the average-of-other-needs-minus-50
    // bonus. Well-fed, well-rested dwarves drift up; chronically deprived
    // ones drift down.
    if (n.decayAccumMorale >= MORALE_TICK_INTERVAL) {
      n.decayAccumMorale -= MORALE_TICK_INTERVAL;
      const baseline = effects?.moraleBaseline ?? 50;
      const avgNeeds = (n.sleep + n.social + n.hunger + n.thirst) / 4;
      const target = Math.max(0, Math.min(100, baseline + (avgNeeds - 50) * 0.4));
      if (n.morale < target) n.morale = Math.min(100, n.morale + 1);
      else if (n.morale > target) n.morale = Math.max(0, n.morale - 1);
    }
    // Death from starvation / dehydration. Thirst kills first because it
    // decays faster; the chronicle records the cause.
    if (n.thirst <= 0) {
      killDwarf(sim, e, "dehydration");
    } else if (n.hunger <= 0) {
      killDwarf(sim, e, "starvation");
    }
  }
}

const MORALE_TICK_INTERVAL = 60; // one morale step per in-game hour

/** Survival-need thresholds at which an in-flight non-survival job is
 * interrupted so the dwarf re-evaluates. Without this a deep miner can
 * walk far enough on a tend or haul leg that they die en route to a
 * remote farm or stockpile while their thirst plummets. */
const INTERRUPT_THIRST = 30;
const INTERRUPT_HUNGER = 25;

/** Stagger chooseTask across this many ticks per dwarf (GDD §12.3). At
 * 6 ticks/sec live and AI_BUCKET_COUNT = 4, an idle dwarf gets a job
 * within ~0.7 real seconds of becoming free — imperceptible to the
 * player but a 4× cut in chooseTask cost as the population grows. The
 * interrupt check above still runs every tick so a critical need
 * doesn't wait for the dwarf's bucket to come round. */
const AI_BUCKET_COUNT = 4;

/** Active-zones radius (GDD §12.3): entities further than this from any
 * dwarf get their per-tick work skipped. Picked so the largest pursue
 * range (cave_troll at 16) plus a comfortable margin still falls
 * inside — a hostile that *could* see a dwarf this tick stays awake.
 * Far hostiles in unexplored corners of the map idle at zero cost. */
const ACTIVE_RADIUS = 100;
const ACTIVE_RADIUS_SQ = ACTIVE_RADIUS * ACTIVE_RADIUS;

/** True if any living dwarf is within ACTIVE_RADIUS of (x, y). Used by
 * hostile movement and combat to early-skip work for entities outside
 * the colony's active footprint. Cheap: at-most O(dwarves) but exits on
 * the first hit, so a hostile near a busy hall returns fast. */
function isInActiveZone(sim: SimWorld, x: number, y: number): boolean {
  let active = false;
  sim.forEachDwarf((_id, p) => {
    if (active) return;
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy <= ACTIVE_RADIUS_SQ) active = true;
  });
  return active;
}

/** For each idle dwarf, run chooseTask and assign the resulting job + path.
 * Also interrupts in-flight non-survival jobs when a critical need crosses
 * the interrupt threshold so the dwarf can divert to food / drink. */
function jobAssignmentSystem(sim: SimWorld): void {
  const dwarves = sim.dwarf.entities;
  // Staggering only pays off once there are more dwarves than buckets
  // — a four-dwarf fortress would just feel slower for no real gain.
  // Below the threshold every dwarf runs chooseTask every tick.
  const stagger = dwarves.length > AI_BUCKET_COUNT;
  for (let i = 0; i < dwarves.length; i++) {
    const e = dwarves[i];
    // Interrupt: critical need overrides a non-survival job in flight.
    const job = sim.job.get(e);
    if (job) {
      const needs = sim.needs.get(e);
      const survivalKind =
        job.kind === "eat" || job.kind === "drink" || job.kind === "sleep" || job.kind === "shelter";
      if (
        needs &&
        !survivalKind &&
        ((needs.thirst <= INTERRUPT_THIRST && sim.stockpile.drink > 0) ||
          (needs.hunger <= INTERRUPT_HUNGER && (sim.stockpile.food > 0 || sim.stockpile.meals > 0)))
      ) {
        if (job.kind === "mine") sim.releaseMineTarget(job.targetX, job.targetY);
        sim.job.remove(e);
        sim.pathing.remove(e);
      }
    }
    if (sim.job.has(e)) continue;
    // Staggered AI (GDD §12.3): each dwarf gets a chooseTask check on
    // its own bucket tick. With AI_BUCKET_COUNT=4 a fortress of 200
    // dwarves runs ~50 choose-task calls per tick instead of 200. The
    // interrupt check above is *not* gated — survival overrides still
    // fire the same tick they trip.
    if (stagger && e % AI_BUCKET_COUNT !== sim.tick % AI_BUCKET_COUNT) continue;
    const pos = sim.position.get(e);
    if (!pos) continue;

    const proposal = chooseTask(sim, e);
    if (!proposal) continue;

    // Plan a path appropriate for the kind of job.
    let path: Int32Array | null = null;
    if (proposal.kind === "mine" || proposal.kind === "engage") {
      // Mine + engage walk *adjacent* to the target (the rock or the
      // hostile) — the existing combat system handles the swing once the
      // soldier and target share a tile boundary.
      path = sim.astar.findPathToNeighbor(sim.grid, pos.x, pos.y, proposal.targetX, proposal.targetY, 6000);
    } else {
      // Sleep / socialise / wander all walk *to* a walkable tile, not adjacent.
      path = sim.astar.findPath(sim.grid, pos.x, pos.y, proposal.targetX, proposal.targetY, 6000);
      // For socialise: if the partner moved between proposal and now, allow
      // adjacency to count (try neighbor pathfinding as fallback).
      if (!path && proposal.kind === "socialise") {
        path = sim.astar.findPathToNeighbor(sim.grid, pos.x, pos.y, proposal.targetX, proposal.targetY, 6000);
      }
    }
    if (!path) continue;

    const pathing: Pathing = { path, pathIndex: 0, goalX: proposal.targetX, goalY: proposal.targetY };
    sim.job.set(e, proposal);
    sim.pathing.set(e, pathing);
    if (proposal.kind === "mine") {
      sim.claimMineTarget(proposal.targetX, proposal.targetY);
    }
  }
}

/** Walk dwarves along their assigned paths one tile per tick. */
function movementSystem(sim: SimWorld): void {
  const pathingEnts = sim.pathing.entities;
  for (let i = 0; i < pathingEnts.length; i++) {
    const e = pathingEnts[i];
    const path = sim.pathing.get(e)!;
    const pos = sim.position.get(e)!;

    if (path.pathIndex >= path.path.length - 1) continue;

    // Replan if the next step became unwalkable since the path was planned.
    const nextCell = unpackCell(path.path[path.pathIndex + 1]);
    if (!sim.grid.isWalkable(nextCell.x, nextCell.y)) {
      const job = sim.job.get(e);
      if (job?.kind === "mine") sim.releaseMineTarget(job.targetX, job.targetY);
      sim.pathing.remove(e);
      sim.job.remove(e);
      continue;
    }

    path.pathIndex++;
    pos.x = nextCell.x;
    pos.y = nextCell.y;
  }
}

/** Execute the dwarf's current job once they've arrived. Dispatch by kind. */
function workSystem(sim: SimWorld): void {
  const jobEnts = sim.job.entities;
  // Iterate backwards so removals don't disturb iteration.
  for (let i = jobEnts.length - 1; i >= 0; i--) {
    const e = jobEnts[i];
    const job = sim.job.get(e)!;
    const pos = sim.position.get(e)!;
    const path = sim.pathing.get(e);

    // Wait until the dwarf finished walking.
    if (path && path.pathIndex < path.path.length - 1) continue;

    switch (job.kind) {
      case "mine":
        progressMine(sim, e, job, pos);
        break;
      case "sleep":
        progressSleep(sim, e, job);
        break;
      case "socialise":
        progressSocialise(sim, e, job);
        break;
      case "wander":
        progressWander(sim, e, job);
        break;
      case "eat":
        progressEat(sim, e, job);
        break;
      case "drink":
        progressDrink(sim, e, job);
        break;
      case "tend":
        progressTend(sim, e, job, pos);
        break;
      case "maintain":
        progressMaintain(sim, e, job, pos);
        break;
      case "shelter":
        progressShelter(sim, e, job, pos);
        break;
      case "haul":
        progressHaul(sim, e, job, pos);
        break;
      case "craft":
        progressCraft(sim, e, job, pos);
        break;
      case "engage":
        progressEngage(sim, e, job, pos);
        break;
      case "research":
        progressResearch(sim, e, job, pos);
        break;
      case "pump":
        progressPump(sim, e, job, pos);
        break;
    }
  }
}

/** Tick a pump cycle while the dwarf stands on a pump-station tile.
 * On completion, drain the nearest water tile within PUMP_DRAIN_RADIUS
 * back to corridor floor — reclaiming flooded space one cell at a time.
 * If there's no reachable water left, the job ends quietly so the
 * dwarf can pick something else up. */
const PUMP_TICKS = 60;
const PUMP_DRAIN_RADIUS = 12;
function progressPump(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  if (sim.grid.getTile(pos.x, pos.y) !== TileType.PumpStation) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  job.progress++;
  if (job.progress < PUMP_TICKS) return;
  // Drain the nearest water tile within range. Deterministic tiebreak
  // by (y, x) — pumps closer to the breach edge dry first.
  let best: { x: number; y: number; d: number } | null = null;
  for (let dy = -PUMP_DRAIN_RADIUS; dy <= PUMP_DRAIN_RADIUS; dy++) {
    for (let dx = -PUMP_DRAIN_RADIUS; dx <= PUMP_DRAIN_RADIUS; dx++) {
      if (dx * dx + dy * dy > PUMP_DRAIN_RADIUS * PUMP_DRAIN_RADIUS) continue;
      const wx = pos.x + dx;
      const wy = pos.y + dy;
      if (sim.grid.getTile(wx, wy) !== TileType.Water) continue;
      const d = dx * dx + dy * dy;
      if (
        !best ||
        d < best.d ||
        (d === best.d && (wy < best.y || (wy === best.y && wx < best.x)))
      ) {
        best = { x: wx, y: wy, d };
      }
    }
  }
  if (best) {
    sim.grid.setTile(best.x, best.y, TileType.CorridorFloor);
  }
  sim.dwarf.get(e)!.lastJobTick = sim.tick;
  sim.job.remove(e);
  sim.pathing.remove(e);
}

/** Tick research progress while the scholar sits at a Library desk.
 * Scholarship skill speeds the work; on completion the topic is logged
 * to the chronicle and the next available topic is auto-picked at the
 * top of the next tick. */
function progressResearch(sim: SimWorld, e: EntityId, _job: JobAssignment, pos: { x: number; y: number }): void {
  const tile = sim.grid.getTile(pos.x, pos.y);
  if (tile !== TileType.LibraryDesk) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  if (!sim.research.current) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  const dw = sim.dwarf.get(e);
  const skill = dw?.skills.scholarship ?? 1;
  const traitBonus = dw ? effectsFor(dw.traitIds).scholarshipBonus : 0;
  // 1 base + 0.04 per effective level above novice.
  const ticksThisStep = 1 + Math.max(0, skill + traitBonus - 1) * 0.04;
  sim.research.progress += ticksThisStep;
  awardSkillXp(sim, e, "scholarship", 1);
  const topic = TOPICS_BY_ID[sim.research.current];
  if (topic && sim.research.progress >= topic.cost) {
    sim.research.completed.push(topic.id);
    sim.research.current = null;
    sim.research.progress = 0;
    sim.events.add(
      sim.tick,
      "milestone",
      `Research complete: ${topic.name}. The colony's understanding deepens.`,
    );
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

/** Soldier engagement: stand adjacent to the target hostile tick after
 * tick. The combat system handles the actual exchange every cooldown
 * period — progressEngage just makes sure the soldier doesn't drift
 * back to civilian work while the fight is on. The job ends when the
 * hostile is dead, has moved out of range, or the soldier himself is
 * out of HP. */
function progressEngage(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  // Has the hostile moved? Re-target each tick: scan all hostiles, pick
  // the one at job.targetX/Y (still there), or fall back to the nearest
  // adjacent one.
  let hostileEnt = -1;
  let hostilePos: { x: number; y: number } | null = null;
  const hEnts = sim.hostile.entities;
  for (let i = 0; i < hEnts.length; i++) {
    const p = sim.position.get(hEnts[i]);
    if (!p) continue;
    if (p.x === job.targetX && p.y === job.targetY) {
      hostileEnt = hEnts[i];
      hostilePos = p;
      break;
    }
  }
  // If the original hostile has moved, look for any adjacent hostile —
  // the soldier swings at whatever's next to them — otherwise drop the
  // job so chooseTask can re-target.
  if (!hostilePos) {
    for (let i = 0; i < hEnts.length; i++) {
      const p = sim.position.get(hEnts[i]);
      if (!p) continue;
      if (Math.abs(p.x - pos.x) <= 1 && Math.abs(p.y - pos.y) <= 1) {
        hostileEnt = hEnts[i];
        hostilePos = p;
        break;
      }
    }
  }
  if (!hostilePos) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  // If we lost adjacency (hostile fled, we got knocked back), update the
  // job target so jobAssignmentSystem repaths next tick.
  const adjacent =
    Math.abs(hostilePos.x - pos.x) <= 1 && Math.abs(hostilePos.y - pos.y) <= 1;
  if (!adjacent) {
    job.targetX = hostilePos.x;
    job.targetY = hostilePos.y;
    // Repath: clear the current path so jobAssignmentSystem can re-plan.
    sim.pathing.remove(e);
    return;
  }
  void hostileEnt;
  job.progress++;
  // Engagement keeps running as long as a hostile is present; combatSystem
  // does the damage. The job ends naturally when the hostile dies and the
  // re-target loop above finds none.
}

/** Run a workshop recipe: while the dwarf stands on the workstation tile,
 * tick a progress counter to the recipe's required ticks, then consume
 * the input quantity from the stockpile and credit the output. The first
 * tick reserves the inputs so a fast recipe can't outrun the stockpile.
 * Skill speeds the work and grants XP per craft. */
function progressCraft(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  if (pos.x !== job.targetX || pos.y !== job.targetY) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  const tile = sim.grid.getTile(pos.x, pos.y);
  // Find the workshop blueprint that owns this workstation.
  let recipe: import("./planner/recipes").Recipe | undefined;
  let blueprintKind: string | undefined;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete") continue;
    const r = recipeFor(b.kind);
    if (!r || r.station !== tile) continue;
    if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
    if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
    recipe = r;
    blueprintKind = b.kind;
    break;
  }
  if (!recipe) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  // Reserve the input on the first tick. Two paths:
  //  - An item of the recipe's input kind sitting on the station (a
  //    hauler dropped it there). Consume the item directly — no
  //    stockpile counter touched. This is the GDD's "items flow into
  //    the workshop" model for resources that exist as item entities.
  //  - Otherwise fall back to the global stockpile counter, the
  //    pre-routing flow that still works for food / drink / bars /
  //    tools (which don't have ItemKinds yet).
  if (job.progress === 0) {
    let consumedItem = false;
    const ents = sim.item.entities;
    for (let i = 0; i < ents.length; i++) {
      const ie = ents[i];
      const it = sim.item.get(ie);
      const p = sim.position.get(ie);
      if (!it || !p) continue;
      if (p.x !== pos.x || p.y !== pos.y) continue;
      if (it.kind !== recipe.inputKind) continue;
      sim.destroyItem(ie);
      consumedItem = true;
      break;
    }
    if (!consumedItem) {
      if (sim.stockpile[recipe.inputKind] < recipe.inputQty) {
        sim.job.remove(e);
        sim.pathing.remove(e);
        return;
      }
      sim.stockpile[recipe.inputKind] -= recipe.inputQty;
    }
  }
  const dw = sim.dwarf.get(e);
  const traitSpeed = dw ? effectsFor(dw.traitIds).workSpeed : 1;
  job.progress += traitSpeed;
  // Skill scales work speed: each level above Novice shaves 4% off ticks.
  const skillLevel = dw?.skills[recipe.skill] ?? 1;
  const scaledTicks = Math.max(8, Math.round(recipe.ticks * Math.max(0.4, 1 - (skillLevel - 1) * 0.04)));
  if (job.progress >= scaledTicks) {
    // Workshop outputs: if the resource has an ItemKind, drop it at
    // the station so a hauler routes it onward (smelter feeds forge,
    // forge stocks the armoury). Otherwise credit the global counter
    // — food, drink, and other counter-only resources still flow that
    // way until they earn their own ItemKinds.
    const outAsItem = outputAsItemKind(recipe.outputKind);
    if (outAsItem) {
      for (let i = 0; i < recipe.outputQty; i++) {
        sim.spawnItem({ kind: outAsItem, x: pos.x, y: pos.y });
      }
    } else {
      sim.stockpile[recipe.outputKind] += recipe.outputQty;
    }
    awardSkillXp(sim, e, recipe.skill, 1);
    // Workshop-firsts as named GDD milestones — Iron Mountain (first
    // bar smelted) and the parallel "first hearth lit" beat for the
    // kitchen.
    if (blueprintKind === "smelter" && recipe.outputKind === "bars") {
      fireMilestone(
        sim,
        "iron_mountain",
        "Iron Mountain. The first bar of metal is drawn from the smelter.",
      );
    }
    if (blueprintKind === "kitchen" && recipe.outputKind === "meals") {
      fireMilestone(
        sim,
        "the_first_hearth",
        "The First Hearth. The kitchen has cooked its first meal.",
      );
    }
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

/** Map a recipe's output resource to an ItemKind if one exists, so the
 * workshop can drop the output as a haulable entity instead of crediting
 * the global counter. Returns null for resources that stay counter-only
 * (food, drink, raw stone, ore, dirt — those that aren't workshop
 * outputs in the current recipe set). */
function outputAsItemKind(resource: string): import("./ecs/components").ItemKind | null {
  if (resource === "bars") return "bars";
  if (resource === "tools") return "tools";
  if (resource === "drink") return "drink";
  if (resource === "meals") return "meal";
  return null;
}

/** Two-phase hauling. progress=0 is the pickup leg: the dwarf has walked
 * to a loose item and grabs it. progress=1 is the delivery leg: the
 * dwarf has walked to a stockpile cell and credits the global counter.
 * Each phase ends by clearing the job so chooseTask reissues the next
 * leg fresh — keeps the state machine boring and easy to save. */
function progressHaul(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  if (job.progress === 0) {
    // Pickup leg.
    if (pos.x !== job.targetX || pos.y !== job.targetY) {
      sim.job.remove(e);
      sim.pathing.remove(e);
      return;
    }
    // Find the item at this tile.
    const ents = sim.item.entities;
    for (let i = 0; i < ents.length; i++) {
      const ie = ents[i];
      const it = sim.item.get(ie);
      const p = sim.position.get(ie);
      if (!it || !p) continue;
      if (p.x !== pos.x || p.y !== pos.y) continue;
      sim.carrying.set(e, { kind: it.kind });
      sim.destroyItem(ie);
      break;
    }
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  // Delivery leg.
  const carrying = sim.carrying.get(e);
  if (!carrying) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  // Three delivery destinations:
  //  - a workshop station that wants this resource (drop the item on
  //    the floor for the workshop's craft job to consume);
  //  - an Armoury rack (drop a tool item there for the draft to equip
  //    soldiers from);
  //  - a stockpile cell (credit the global counter).
  const tile = sim.grid.getTile(pos.x, pos.y);
  let droppedAsItem = false;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete") continue;
    const recipe = recipeFor(b.kind);
    if (!recipe) continue;
    if (recipe.station !== tile) continue;
    if (recipe.inputKind !== carrying.kind) continue;
    if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
    if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
    sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y });
    droppedAsItem = true;
    break;
  }
  if (!droppedAsItem && carrying.kind === "tools" && tile === TileType.ArmouryRack) {
    sim.spawnItem({ kind: "tools", x: pos.x, y: pos.y });
    droppedAsItem = true;
  }
  if (!droppedAsItem) {
    if (carrying.kind === "ore") sim.stockpile.ore++;
    else if (carrying.kind === "stone") sim.stockpile.stone++;
    else if (carrying.kind === "dirt") sim.stockpile.dirt++;
    else if (carrying.kind === "gem") sim.stockpile.gems++;
    else if (carrying.kind === "bars") sim.stockpile.bars++;
    else if (carrying.kind === "tools") sim.stockpile.tools++;
    else if (carrying.kind === "food") sim.stockpile.food++;
    else if (carrying.kind === "drink") sim.stockpile.drink++;
    else if (carrying.kind === "meal") sim.stockpile.meals++;
  }
  sim.carrying.remove(e);
  sim.dwarf.get(e)!.lastJobTick = sim.tick;
  sim.job.remove(e);
  sim.pathing.remove(e);
}

/** Sit at the Safe Zone tile until the emergency lifts. The job is dropped
 * and chooseTask re-evaluates as soon as the shelter mode ends. */
function progressShelter(sim: SimWorld, e: EntityId, _job: JobAssignment, _pos: { x: number; y: number }): void {
  if (sim.emergency.mode !== "alarm" && sim.emergency.mode !== "evacuate") {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
  // While sheltering, the job sticks. The dwarf has already pathed to the
  // spawn (or as close as they can reach); they stand idle there.
}

function progressMine(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  // Adjacency check.
  const dx = Math.abs(pos.x - job.targetX);
  const dy = Math.abs(pos.y - job.targetY);
  if (dx > 1 || dy > 1) {
    sim.releaseMineTarget(job.targetX, job.targetY);
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  if (!sim.grid.isSolid(job.targetX, job.targetY)) {
    sim.releaseMineTarget(job.targetX, job.targetY);
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  // Trait-driven work pace — Diligent / Lazy / Efficient / Perfectionist
  // scale how fast progress accrues per tick.
  const dwM = sim.dwarf.get(e);
  const mineSpeed = dwM ? effectsFor(dwM.traitIds).workSpeed : 1;
  job.progress += mineSpeed;
  if (job.progress >= MINE_TICKS) {
    // What was the rock made of? Determines stockpile credit.
    const tileType = sim.grid.getTile(job.targetX, job.targetY);
    // Aquifer breach: replace with water rather than corridor floor,
    // mark the colony's aquifer-clock for the Survived milestone, and
    // log a chronicle line. The flood system spreads water from here
    // into adjacent walkable cells over the next several days.
    if (tileType === TileType.Aquifer) {
      sim.grid.setTile(job.targetX, job.targetY, TileType.Water);
      sim.grid.setDesignation(job.targetX, job.targetY, 0);
      sim.releaseMineTarget(job.targetX, job.targetY);
      const dw = sim.dwarf.get(e)!;
      sim.events.add(
        sim.tick,
        "crisis",
        `${dw.name} struck an aquifer. Water bursts into the tunnel.`,
      );
      if (sim.aquiferBreachTick < 0) sim.aquiferBreachTick = sim.tick;
      sim.dwarf.get(e)!.lastJobTick = sim.tick;
      sim.job.remove(e);
      sim.pathing.remove(e);
      return;
    }
    sim.grid.setTile(job.targetX, job.targetY, TileType.CorridorFloor);
    sim.grid.setDesignation(job.targetX, job.targetY, 0);
    sim.releaseMineTarget(job.targetX, job.targetY);
    // Grant mining XP and announce tier crossings ("become a Skilled Miner").
    awardSkillXp(sim, e, "mining", 1);

    // Drop the rock as a haulable item on the freshly-excavated tile.
    // A separate hauler job picks it up later and carries it to the
    // stockpile. The first-strike narration still fires the moment the
    // ore is broken.
    let itemKind: import("./ecs/components").ItemKind | null = null;
    if (tileType === TileType.Ore) {
      itemKind = "ore";
      if (!sim.oreEverStruck) {
        sim.oreEverStruck = true;
        const dw = sim.dwarf.get(e)!;
        sim.events.add(
          sim.tick,
          "discovery",
          narrateOreFirstStrike(sim.plannerRng, dw.name, job.targetY, sim.spawn.y),
        );
      }
    } else if (
      tileType === TileType.RawDiamond ||
      tileType === TileType.RawRuby ||
      tileType === TileType.RawEmerald ||
      tileType === TileType.SoulCrystal
    ) {
      itemKind = "gem";
      const dw = sim.dwarf.get(e)!;
      const gemName =
        tileType === TileType.RawDiamond ? "diamond" :
        tileType === TileType.RawRuby ? "ruby" :
        tileType === TileType.RawEmerald ? "emerald" : "soul-crystal";
      sim.events.add(
        sim.tick,
        "discovery",
        `${dw.name} strikes a ${gemName} cluster, ${depthPhraseFor(job.targetY, sim.spawn.y)}.`,
      );
      if (tileType === TileType.RawDiamond) {
        fireMilestone(
          sim,
          "the_first_diamond",
          `The First Diamond. ${dw.name} has cut a diamond from the rock.`,
        );
      }
    } else if (tileType === TileType.Adamantite || tileType === TileType.VoidOre) {
      // Treated as ore for now — Tier 5 Adamantite Smelting and Tier 6
      // Void Metallurgy split these out into their own counters when
      // their research lands.
      itemKind = "ore";
      const dw = sim.dwarf.get(e)!;
      const name = tileType === TileType.Adamantite ? "adamantite" : "void-ore";
      sim.events.add(
        sim.tick,
        "discovery",
        `${dw.name} strikes ${name}, ${depthPhraseFor(job.targetY, sim.spawn.y)}.`,
      );
    } else if (tileType === TileType.Silver) {
      // Drops as ore for now (Silver smelting is its own future tier);
      // the milestone fires here regardless.
      itemKind = "ore";
      const dw = sim.dwarf.get(e)!;
      sim.events.add(
        sim.tick,
        "discovery",
        `${dw.name} strikes silver, ${depthPhraseFor(job.targetY, sim.spawn.y)}.`,
      );
      fireMilestone(
        sim,
        "the_silver_halls",
        `The Silver Halls. ${dw.name} has cut silver from the deep rock.`,
      );
    } else if (tileType === TileType.Stone || tileType === TileType.Granite) {
      itemKind = "stone";
    } else if (tileType === TileType.Dirt || tileType === TileType.Sand) {
      itemKind = "dirt";
    }
    if (itemKind) {
      sim.spawnItem({ kind: itemKind, x: job.targetX, y: job.targetY });
    }

    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressSleep(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  const needs = sim.needs.get(e);
  if (!needs) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  job.progress++;
  // Sleeping on a bed restores ~3× faster than the bare floor — the
  // mechanical reason a bedroom is more than just a labelled cavity.
  const pos = sim.position.get(e);
  const onBed = pos ? sim.grid.getTile(pos.x, pos.y) === TileType.Bed : false;
  if (onBed) {
    needs.sleep = Math.min(100, needs.sleep + 1);
  } else if (job.progress % 3 === 0) {
    needs.sleep = Math.min(100, needs.sleep + 1);
  }
  if (job.progress >= SLEEP_TICKS || needs.sleep >= 95) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressSocialise(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  const myNeeds = sim.needs.get(e);
  if (!myNeeds) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  job.progress++;
  // Both dwarves gain social each tick of conversation. Trait-driven
  // appetite — Gregarious gains 2× from chat, Solitary gains nothing.
  const myDw = sim.dwarf.get(e);
  const myEffects = myDw ? effectsFor(myDw.traitIds) : null;
  myNeeds.social = Math.min(100, myNeeds.social + 2 * (myEffects?.socialMoraleScale ?? 1));
  // A pleasant chat also nudges morale upward.
  myNeeds.morale = Math.min(100, myNeeds.morale + 1 * (myEffects?.socialMoraleScale ?? 1));
  if (job.partnerId !== undefined) {
    const partnerNeeds = sim.needs.get(job.partnerId);
    const partnerDw = sim.dwarf.get(job.partnerId);
    const partnerEffects = partnerDw ? effectsFor(partnerDw.traitIds) : null;
    if (partnerNeeds) {
      partnerNeeds.social = Math.min(100, partnerNeeds.social + 2 * (partnerEffects?.socialMoraleScale ?? 1));
      partnerNeeds.morale = Math.min(100, partnerNeeds.morale + 1 * (partnerEffects?.socialMoraleScale ?? 1));
    }
  }
  if (job.progress >= SOCIALISE_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressEat(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  const needs = sim.needs.get(e);
  if (!needs) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  // The dwarf consumes one unit of food on the first tick of the meal so
  // a starving dwarf with food in the stockpile recovers immediately;
  // the rest of EAT_TICKS is the visible "eating" duration. A cooked
  // meal restores 90 hunger (vs. 60 for raw food) — the kitchen earns
  // its keep.
  if (job.progress === 0) {
    if (sim.stockpile.meals > 0) {
      sim.stockpile.meals -= 1;
      needs.hunger = Math.min(100, needs.hunger + 90);
    } else if (sim.stockpile.food > 0) {
      sim.stockpile.food -= 1;
      needs.hunger = Math.min(100, needs.hunger + 60);
    }
  }
  job.progress++;
  if (job.progress >= EAT_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

/**
 * Tend a farm cell: stamp `cellTendedAt` for the matching blueprint cell
 * to the current tick. The job runs over a short fixed duration (visible
 * "tending" beat), then completes. The cell stays productive for
 * TEND_VALIDITY_TICKS afterwards before going fallow again.
 */
const TEND_TICKS = 18;
function progressTend(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  // Stamp on the first tick so even an interrupted tend (a rat shows up,
  // the dwarf flees) records the work that did happen.
  if (job.progress === 0) {
    // Find the farm blueprint that owns this tile, mark the cell tended.
    for (const b of sim.planner.blueprints) {
      if (b.kind !== "farm" || b.status !== "complete" || !b.cellTendedAt) continue;
      // Only check if the tile is inside the bounding rect (cheap reject).
      if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
      if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
      for (let i = 0; i < b.cavity.length; i++) {
        const c = b.cavity[i];
        const x = c & 0xffff;
        const y = (c >>> 16) & 0xffff;
        if (x === pos.x && y === pos.y) {
          b.cellTendedAt[i] = sim.tick;
          break;
        }
      }
    }
  }
  job.progress++;
  if (job.progress >= TEND_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

/**
 * Maintain a completed room: stamp `lastMaintainedTick` on the blueprint
 * whose cavity contains the dwarf's tile. Runs over a short fixed duration
 * (visible "tidying" beat). The room counts as fresh for
 * MAINTAIN_VALIDITY_TICKS afterwards before going neglected again — at
 * which point either the same dwarf or another picks it up.
 */
const MAINTAIN_TICKS = 30;
function progressMaintain(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  // Stamp on the first tick so even an interrupted maintenance pass records
  // the work that did happen.
  if (job.progress === 0) {
    for (const b of sim.planner.blueprints) {
      if (b.status !== "complete") continue;
      if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
      if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
      // Confirm the tile is part of the cavity (not just inside the bbox).
      let inside = false;
      for (let i = 0; i < b.cavity.length; i++) {
        const c = b.cavity[i];
        if ((c & 0xffff) === pos.x && ((c >>> 16) & 0xffff) === pos.y) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      b.lastMaintainedTick = sim.tick;
      break;
    }
  }
  job.progress++;
  if (job.progress >= MAINTAIN_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressDrink(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  const needs = sim.needs.get(e);
  if (!needs) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  if (job.progress === 0 && sim.stockpile.drink > 0) {
    sim.stockpile.drink -= 1;
    needs.thirst = Math.min(100, needs.thirst + 60);
  }
  job.progress++;
  if (job.progress >= DRINK_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressWander(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  // Already at destination by virtue of getting here; linger briefly so the
  // dwarf isn't reassigned the same tick they arrived.
  job.progress++;
  if (job.progress >= WANDER_LINGER_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

// ---- Recovery ----------------------------------------------------------

const HEAL_TICK_INTERVAL = 30;
const HEAL_RATE_BED = 3;
const HEAL_RATE_RESTING = 2; // sleeping anywhere
const HEAL_RATE_IDLE = 1;    // wandering / socialising

/**
 * Passive recovery. Dwarves regain HP slowly — faster while sleeping,
 * fastest while sleeping on a bed (the same mechanical reason that bedrooms
 * matter for sleep restoration). Combat suspends healing: a dwarf adjacent
 * to a hostile gets no benefit until the hostile is dead or out of reach.
 *
 * Also fires a "recovered" event when a previously-severely-wounded dwarf
 * (HP below 30%) reaches full health, so the chronicle records the relief.
 */
function healingSystem(sim: SimWorld): void {
  if (sim.tick % HEAL_TICK_INTERVAL !== 0) return;
  const dwarves = sim.dwarf.entities;
  for (let i = 0; i < dwarves.length; i++) {
    const e = dwarves[i];
    const hp = sim.health.get(e);
    if (!hp || hp.hp >= hp.maxHp) continue;
    const pos = sim.position.get(e);
    if (!pos) continue;

    // Combat lock: no healing if any hostile is adjacent.
    let inCombat = false;
    const hEnts = sim.hostile.entities;
    for (let j = 0; j < hEnts.length && !inCombat; j++) {
      const hp2 = sim.position.get(hEnts[j]);
      if (!hp2) continue;
      if (Math.abs(hp2.x - pos.x) <= 1 && Math.abs(hp2.y - pos.y) <= 1) inCombat = true;
    }
    if (inCombat) continue;

    let healing = 0;
    const job = sim.job.get(e);
    if (job?.kind === "sleep") {
      healing = sim.grid.getTile(pos.x, pos.y) === TileType.Bed ? HEAL_RATE_BED : HEAL_RATE_RESTING;
    } else if (!job || job.kind === "wander" || job.kind === "socialise") {
      healing = HEAL_RATE_IDLE;
    }
    // Working (mining) suspends healing — the dwarf is exerting themselves.
    if (healing === 0) continue;

    hp.hp = Math.min(hp.maxHp, hp.hp + healing);
    // Severe-recovery announcement: combat sets `wasSevereWound` when HP
    // dropped below 30%; we clear it (and write to the chronicle) the
    // first time the dwarf returns to full HP.
    if (hp.wasSevereWound && hp.hp >= hp.maxHp) {
      hp.wasSevereWound = false;
      const dw = sim.dwarf.get(e);
      if (dw) {
        sim.events.add(
          sim.tick,
          "social",
          `${dw.name} has recovered from their wounds.`,
        );
      }
    }
  }
}

// ---- Hazards: spawning, movement, combat ------------------------------

/** HP fraction below which a wound counts as "severe" — used both to set
 * the recovery-event flag in combat and to gate the "wounded seeks rest"
 * branch in chooseTask. */
const SEVERE_WOUND_RATIO = 0.3;

const HOSTILE_SPAWN_INTERVAL_TICKS = TICKS_PER_DAY; // try once per in-game day
const HOSTILE_SPAWN_CHANCE = 0.4;
const HOSTILE_MIN_DISTANCE_FROM_DWARF = 8;
const DWARF_BASE_DAMAGE = 6;
const DWARF_ATTACK_COOLDOWN = 60;

/**
 * Periodically a creature finds its way into the colony. We pick a
 * reachable walkable tile that is (a) deep enough for the kind to spawn,
 * (b) safely away from any dwarf so they get to discover it. Cap is
 * proportional to the colony's size so a one-dwarf colony isn't swarmed.
 */
function hostileSpawnSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % HOSTILE_SPAWN_INTERVAL_TICKS !== 0) return;
  // Cap: 1 hostile per 3 dwarves, min 1.
  const dwarves = sim.dwarf.size();
  if (dwarves === 0) return;
  const cap = Math.max(1, Math.floor(dwarves / 3));
  if (sim.hostile.size() >= cap) return;
  if (sim.aiRng.nextFloat() >= HOSTILE_SPAWN_CHANCE) return;

  // Pick a creature kind weighted by the deepest dwarf the colony has —
  // a surface fortress sees rats and spiders; a colony pushing into Deep
  // Rock starts seeing goblin scouts and the occasional troll.
  const reachable = sim.planner.exposeReachable(sim);
  if (!reachable) return;
  const grid = sim.grid;
  const w = grid.width;
  let deepestY = sim.spawn.y;
  sim.forEachDwarf((_id, p) => {
    if (p.y > deepestY) deepestY = p.y;
  });
  const kind = pickHostileKind(sim, deepestY);
  const def = HOSTILE_DEFS[kind];
  const minY = sim.spawn.y + def.minDepth;
  const candidates: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < reachable.length; i++) {
    if (reachable[i] !== 1) continue;
    const y = (i / w) | 0;
    if (y < minY) continue;
    const x = i % w;
    // Reject any tile too close to a dwarf — the chronicle's whole point is
    // the dwarves *discovering* the threat, not bumping into it at spawn.
    let tooClose = false;
    sim.forEachDwarf((_id, p) => {
      if (tooClose) return;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < HOSTILE_MIN_DISTANCE_FROM_DWARF * HOSTILE_MIN_DISTANCE_FROM_DWARF) {
        tooClose = true;
      }
    });
    if (!tooClose) candidates.push({ x, y });
  }
  if (candidates.length === 0) return;
  const pick = candidates[sim.aiRng.nextRange(0, candidates.length)];
  sim.spawnHostile({ kind, x: pick.x, y: pick.y });
  sim.events.add(
    sim.tick,
    "crisis",
    narrateHostileSpawn(sim.aiRng, def.spawnArticle, pick.y, sim.spawn.y),
  );
}

/** Weighted random hostile kind. Each kind only enters the pool once
 * the colony has actually reached its minDepth — the player should see
 * a fortress at the surface get only rats, while one in the deep rock
 * starts seeing the harder kinds. */
function pickHostileKind(sim: SimWorld, deepestY: number): HostileKind {
  const reachableDepth = deepestY - sim.spawn.y;
  const eligible: HostileKind[] = ["cave_rat"]; // always available
  if (reachableDepth >= HOSTILE_DEFS.cave_spider.minDepth) eligible.push("cave_spider");
  if (reachableDepth >= HOSTILE_DEFS.goblin_scout.minDepth) eligible.push("goblin_scout", "goblin_scout");
  if (reachableDepth >= HOSTILE_DEFS.cave_troll.minDepth) eligible.push("cave_troll");
  return eligible[sim.aiRng.nextRange(0, eligible.length)];
}

/**
 * Greedy pursuit: each tick, each hostile (rate-limited per kind) takes
 * a single step toward the nearest dwarf within pursueRange — no A*, just
 * a sign-of-delta step, fenced by walkability. Cheap and good enough for
 * cave-rat-scale threats; smarter creatures get proper pathing later.
 */
function hostileMovementSystem(sim: SimWorld): void {
  const ents = sim.hostile.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const h = sim.hostile.get(e);
    if (!h) continue;
    const def = HOSTILE_DEFS[h.kind];
    if (sim.tick - h.lastMoveTick < def.moveCooldown) continue;
    const pos = sim.position.get(e);
    if (!pos) continue;
    // Active-zones gate (GDD §12.3): if no dwarf is within ACTIVE_RADIUS
    // of this hostile, skip the per-dwarf nearest-search entirely.
    // Hostiles in a sealed-off corner of the map don't burn cycles
    // until a dwarf wanders close.
    if (!isInActiveZone(sim, pos.x, pos.y)) continue;
    // Find nearest dwarf within pursue range.
    let bestDist = def.pursueRange * def.pursueRange + 1;
    let bestPos: { x: number; y: number } | null = null;
    sim.forEachDwarf((_id, p) => {
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        bestPos = { x: p.x, y: p.y };
      }
    });
    if (!bestPos) continue;
    h.lastMoveTick = sim.tick;
    const target: { x: number; y: number } = bestPos;
    const dx = Math.sign(target.x - pos.x);
    const dy = Math.sign(target.y - pos.y);
    // Try the diagonal first, then horizontal-only, then vertical-only.
    const tries: Array<[number, number]> = [
      [pos.x + dx, pos.y + dy],
      [pos.x + dx, pos.y],
      [pos.x, pos.y + dy],
    ];
    for (const [nx, ny] of tries) {
      if (nx === pos.x && ny === pos.y) continue;
      if (!sim.grid.isWalkable(nx, ny)) continue;
      pos.x = nx;
      pos.y = ny;
      break;
    }
  }
}

/**
 * Adjacent dwarves and hostiles exchange damage on cooldown. Either side
 * dropping to 0 HP dies on the spot. Dwarf deaths re-use killDwarf so the
 * memorial-tile + bereavement pipeline still works.
 */
function combatSystem(sim: SimWorld): void {
  const hEnts = sim.hostile.entities.slice(); // snapshot — combat may remove
  for (const h of hEnts) {
    const hPos = sim.position.get(h);
    const hHealth = sim.health.get(h);
    // Active-zones gate: if no dwarf is anywhere near this hostile,
    // there can't be an adjacent target for combat. Skip without doing
    // the per-dwarf adjacency scan.
    if (hPos && !isInActiveZone(sim, hPos.x, hPos.y)) continue;
    const hostile = sim.hostile.get(h);
    if (!hPos || !hHealth || !hostile) continue;
    const def = HOSTILE_DEFS[hostile.kind];
    // Find adjacent dwarf (within 1 tile in any direction).
    let target: EntityId | null = null;
    let targetPos: { x: number; y: number } | null = null;
    sim.forEachDwarf((id, p) => {
      if (target !== null) return;
      if (Math.abs(p.x - hPos.x) <= 1 && Math.abs(p.y - hPos.y) <= 1) {
        target = id;
        targetPos = { x: p.x, y: p.y };
      }
    });
    if (target === null || targetPos === null) continue;

    // Hostile attacks dwarf on its cooldown.
    if (sim.tick - hostile.lastAttackTick >= def.attackCooldown) {
      hostile.lastAttackTick = sim.tick;
      const dwarfHealth = sim.health.get(target);
      if (dwarfHealth) {
        // Furious dwarves are effectively unkillable for the duration
        // of the rage — incoming damage is absorbed without effect
        // (GDD §6.5 The Fury).
        const damageIn = sim.fury.has(target) ? 0 : def.damage;
        dwarfHealth.hp -= damageIn;
        // Latch a "was severe wound" flag once HP crosses below 30% of
        // max; the recovery event in healingSystem fires when the flag
        // is still set and HP returns to full.
        if (dwarfHealth.hp <= dwarfHealth.maxHp * SEVERE_WOUND_RATIO) {
          dwarfHealth.wasSevereWound = true;
        }
        if (dwarfHealth.hp <= 0) {
          killDwarf(sim, target, `slain by ${def.spawnArticle}`);
        }
      }
    }

    // Surviving dwarf retaliates (shared cooldown stored on Health).
    if (!sim.ecs.isAlive(target)) continue;
    const dHealth = sim.health.get(target);
    if (!dHealth) continue;
    if (sim.tick - dHealth.lastAttackTick >= DWARF_ATTACK_COOLDOWN) {
      dHealth.lastAttackTick = sim.tick;
      // Damage scales modestly with the military skill (no military skill
      // = base damage). Mining skill doesn't help in a fight. Drafted
      // soldiers carry a flat +5 bonus, and an equipped soldier adds
      // another +8 — a trained guard with a forged tool outclasses a
      // panicking miner two ways over.
      const dwarf = sim.dwarf.get(target);
      const military = dwarf?.skills.military ?? 1;
      const isSoldier = sim.squad.has(target);
      const equipped = sim.equipment.get(target)?.weapon === true;
      const inFury = sim.fury.has(target);
      const damage =
        DWARF_BASE_DAMAGE +
        Math.floor((military - 1) / 2) +
        (isSoldier ? 5 : 0) +
        (equipped ? 8 : 0) +
        (inFury ? 30 : 0); // The Fury: huge bonus, hostiles fall fast.
      hHealth.hp -= damage;
      if (hHealth.hp <= 0) {
        const dwarfName = dwarf?.name ?? "A dwarf";
        sim.events.add(
          sim.tick,
          "crisis",
          narrateHostileSlain(sim.aiRng, dwarfName, def.name),
        );
        // Track void-shade kills toward The Siege Endured milestone —
        // surviving the King's emissaries. Defeating the King himself
        // is a separate beat, gated on the actual hollow_king hostile
        // (spawned by Tier-6 research) being put down.
        if (hostile.kind === "void_shade") {
          sim.voidShadesSlain++;
          if (sim.voidShadesSlain >= HOLLOW_KING_VICTORY_THRESHOLD) {
            fireMilestone(
              sim,
              "the_siege_endured",
              "The Siege Endured. The colony has put down enough of the King's emissaries that the night feels quieter. The dreams thin out.",
            );
          }
        }
        if (hostile.kind === "hollow_king") {
          fireMilestone(
            sim,
            "the_hollow_king_falls",
            "The Hollow King Falls. The King is dead. The mountain is the dwarves' alone, for as long as anyone remembers.",
          );
        }
        sim.ecs.destroy(h, [sim.position, sim.hostile, sim.health]);
      }
    }
  }
}
