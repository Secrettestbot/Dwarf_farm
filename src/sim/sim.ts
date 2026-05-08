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
  visibilitySystem(sim);
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
  }
  // Anyone in the squad component but no longer in the keep set is
  // demobilised. Mostly happens when population shrinks past the cap.
  const sEnts = sim.squad.entities.slice();
  for (const id of sEnts) {
    if (!keep.has(id)) {
      sim.squad.remove(id);
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
        sim.stockpile.food += 1;
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
  sim.ecs.destroy(e, [sim.position, sim.dwarf, sim.pathing, sim.job, sim.needs, sim.health, sim.carrying, sim.squad]);
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
  });
  void childId;
  sim.events.add(sim.tick, "social", narrateBirth(sim.aiRng, childName, mother.name, father.name));
  // Population milestones (GDD §10.2). One-shot per threshold via Set.
  checkPopulationMilestones(sim);
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

/** For each idle dwarf, run chooseTask and assign the resulting job + path.
 * Also interrupts in-flight non-survival jobs when a critical need crosses
 * the interrupt threshold so the dwarf can divert to food / drink. */
function jobAssignmentSystem(sim: SimWorld): void {
  const dwarves = sim.dwarf.entities;
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
          (needs.hunger <= INTERRUPT_HUNGER && sim.stockpile.food > 0))
      ) {
        if (job.kind === "mine") sim.releaseMineTarget(job.targetX, job.targetY);
        sim.job.remove(e);
        sim.pathing.remove(e);
      }
    }
    if (sim.job.has(e)) continue;
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
    }
  }
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
    sim.stockpile[recipe.outputKind] += recipe.outputQty;
    awardSkillXp(sim, e, recipe.skill, 1);
    void blueprintKind;
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
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
  // Two delivery destinations: a workshop station that wants this
  // resource (drop the item on the floor for the workshop's craft job
  // to consume), or a stockpile cell (credit the global counter).
  const tile = sim.grid.getTile(pos.x, pos.y);
  let droppedAtWorkshop = false;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete") continue;
    const recipe = recipeFor(b.kind);
    if (!recipe) continue;
    if (recipe.station !== tile) continue;
    if (recipe.inputKind !== carrying.kind) continue;
    if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
    if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
    sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y });
    droppedAtWorkshop = true;
    break;
  }
  if (!droppedAtWorkshop) {
    if (carrying.kind === "ore") sim.stockpile.ore++;
    else if (carrying.kind === "stone") sim.stockpile.stone++;
    else if (carrying.kind === "dirt") sim.stockpile.dirt++;
    else if (carrying.kind === "gem") sim.stockpile.gems++;
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
  // the rest of EAT_TICKS is the visible "eating" duration.
  if (job.progress === 0 && sim.stockpile.food > 0) {
    sim.stockpile.food -= 1;
    needs.hunger = Math.min(100, needs.hunger + 60);
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
        dwarfHealth.hp -= def.damage;
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
      // soldiers carry a flat +5 bonus that civilians caught in combat
      // don't have — a trained guard outclasses a panicking miner.
      const dwarf = sim.dwarf.get(target);
      const military = dwarf?.skills.military ?? 1;
      const isSoldier = sim.squad.has(target);
      const damage =
        DWARF_BASE_DAMAGE + Math.floor((military - 1) / 2) + (isSoldier ? 5 : 0);
      hHealth.hp -= damage;
      if (hHealth.hp <= 0) {
        const dwarfName = dwarf?.name ?? "A dwarf";
        sim.events.add(
          sim.tick,
          "crisis",
          narrateHostileSlain(sim.aiRng, dwarfName, def.name),
        );
        sim.ecs.destroy(h, [sim.position, sim.hostile, sim.health]);
      }
    }
  }
}
