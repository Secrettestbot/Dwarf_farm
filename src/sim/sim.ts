import { SimWorld } from "./world/simWorld";
import { chooseTask } from "./jobs/chooseTask";
import { TileType } from "./world/tiles";
import { unpackCell } from "./pathing/astar";
import { JobAssignment, Pathing } from "./ecs/components";
import { EntityId } from "./ecs/world";
import { narrateOreFirstStrike, narrateDeath, narratePairing, narrateBirth, narrateBereavement, narrateHostileSpawn, narrateHostileSlain, narrateArrival } from "./events/narrator";
import { TICKS_PER_YEAR, TICKS_PER_DAY, TICKS_PER_HOUR, TICKS_PER_SEASON, seasonOf, Season } from "./time";
import { inheritTraits, newbornSkills, rollChildName } from "./dwarves/birth";
import { generateFounder } from "./dwarves/founders";
import { levelFromXp } from "./dwarves/skillProgress";
import { skillTier, skillTierLabel, SKILLS_BY_ID, SkillId } from "./dwarves/skills";
import { HOSTILE_DEFS, HostileKind } from "./hostiles/types";
import { ALARM_DURATION_TICKS, ALARM_COOLDOWN_TICKS } from "./emergency";
import { recipeFor } from "./planner/recipes";
import { QUALITY_BASE, QUALITY_MAX, QUALITY_PER_MAINTAIN, isMaintainable } from "./planner/blueprint";
import { effectsFor } from "./dwarves/traitEffects";
import { nextTopic, TOPICS_BY_ID } from "./research";

// One in-game minute = MOVE_TICKS to step one tile, MINE_TICKS to break a tile.
// Tuning is intentionally fast for early sessions so behavior is visible.
export const MOVE_TICKS = 1;
/** Base ticks to mine a generic rock tile. Material-specific hardness
 * scales this up; mining-skill and pickaxe-quality scale it down. */
export const MINE_TICKS = 6;
/** Per-material hardness multiplier applied to MINE_TICKS. Surface
 * dirt is fast; granite is harder than stone; gem-seam crystals are
 * tough; the deep-rock metals (adamantite, void-ore) are the
 * fortress's grindstone — without a forged pickaxe they're nearly
 * untouchable. */
const MATERIAL_HARDNESS: Record<number, number> = {
  // Surface and skin layer.
  [TileType.Dirt]: 0.5,
  [TileType.Sand]: 0.5,
  [TileType.Tree]: 1.0,
  // Shallow earth.
  [TileType.Stone]: 1.0,
  [TileType.Aquifer]: 1.5,
  // Deep rock.
  [TileType.Granite]: 1.5,
  [TileType.Ore]: 1.6,
  [TileType.Coal]: 1.2,
  [TileType.Silver]: 1.7,
  [TileType.Gold]: 1.8,
  // Gem seam.
  [TileType.RawEmerald]: 2.0,
  [TileType.RawRuby]: 2.2,
  [TileType.RawDiamond]: 2.5,
  // Ancient dark / underworld.
  [TileType.Adamantite]: 3.5,
  [TileType.VoidOre]: 4.5,
  [TileType.SoulCrystal]: 3.0,
  // Cave mushroom is soft — it's a mushroom.
  [TileType.CaveMushroom]: 0.4,
};
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
  seasonRolloverSystem(sim);
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
  tavernSystem(sim);
  legendarySpecialtiesSystem(sim);
  tradeSystem(sim);
  hollowKingSystem(sim);
  hollowKingManifestSystem(sim);
  specialTraitSystem(sim);
  passiveTraitSystem(sim);
  furyEndSystem(sim);
  engravingSystem(sim);
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
/** Per-day chance for an Obsessive dwarf without an active obsession
 * to fall into one. Tuned so most Obsessive dwarves fixate a few
 * times per in-game year — frequent enough that a fortress with one
 * actually feels their presence. */
const OBSESSION_DAILY_CHANCE = 0.02;
const OBSESSION_DURATION_TICKS = TICKS_PER_DAY * 7;
/** Skill ids the Obsessive trait can fixate on. Subset of the GDD's
 * full skill list — only the ones a dwarf actually trains in
 * gameplay today. */
const OBSESSION_SKILLS = [
  "mining",
  "smithing",
  "cooking",
  "brewing",
  "scholarship",
  "military",
  "artistry",
  "trading",
] as const;

function specialTraitSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  // Obsession lifecycle (GDD §6.5 Obsessive): expire any active
  // obsessions whose timer has elapsed, then roll once per in-game
  // day for new ones on the dwarves who carry the trait.
  const obsEnts = sim.obsession.entities.slice();
  for (const id of obsEnts) {
    const ob = sim.obsession.get(id);
    if (!ob) continue;
    if (sim.tick >= ob.endsAtTick) {
      const dw = sim.dwarf.get(id);
      if (dw) {
        sim.events.add(
          sim.tick,
          "social",
          `${dw.name} loses their grip on the obsession with ${ob.skillId}. They look around as if waking up.`,
        );
      }
      sim.obsession.remove(id);
    }
  }
  if (sim.tick % TICKS_PER_DAY === 0) {
    for (const id of sim.dwarf.entities) {
      const dw = sim.dwarf.get(id);
      if (!dw || !dw.traitIds.includes("obsessive")) continue;
      if (sim.obsession.has(id)) continue;
      if (sim.aiRng.nextFloat() >= OBSESSION_DAILY_CHANCE) continue;
      const skillId = OBSESSION_SKILLS[sim.aiRng.nextRange(0, OBSESSION_SKILLS.length)];
      sim.obsession.set(id, { skillId, endsAtTick: sim.tick + OBSESSION_DURATION_TICKS });
      sim.events.add(
        sim.tick,
        "social",
        `${dw.name} has fallen into a deep fixation with ${skillId}. They are not to be reasoned with for a week.`,
      );
    }
  }
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

// ---- Passive trait auras (GDD §6.5) ----------------------------------
//
// Some traits influence the dwarves around them rather than
// themselves. Once per in-game hour we sweep the population:
// - Natural Leaders give a small morale bump to every dwarf within
//   8 tiles, themselves included.
// - Phobia: Deep Rock dwarves working below depth 300 lose morale
//   instead of gaining it (their own personal Esteem need bites).

const PASSIVE_TRAIT_INTERVAL = 60; // once per in-game hour
const LEADER_AURA_RADIUS = 8;

function passiveTraitSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % PASSIVE_TRAIT_INTERVAL !== 0) return;
  const ents = sim.dwarf.entities;
  // Aura pass — Natural Leader (+1) and Antagonistic (-1) both run
  // through the same shape: walk every dwarf within LEADER_AURA_RADIUS
  // and apply auraMorale.
  for (const id of ents) {
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const aura = effectsFor(dw.traitIds).auraMorale;
    if (aura === 0) continue;
    const pos = sim.position.get(id);
    if (!pos) continue;
    for (const other of ents) {
      const op = sim.position.get(other);
      if (!op) continue;
      const dx = op.x - pos.x;
      const dy = op.y - pos.y;
      if (dx * dx + dy * dy > LEADER_AURA_RADIUS * LEADER_AURA_RADIUS) continue;
      const n = sim.needs.get(other);
      if (!n) continue;
      n.morale = Math.max(0, Math.min(100, n.morale + aura));
    }
  }
  // Phobia: Deep Rock pass.
  for (const id of ents) {
    const dw = sim.dwarf.get(id);
    if (!dw || !dw.traitIds.includes("phobia_deep")) continue;
    const pos = sim.position.get(id);
    if (!pos) continue;
    if (pos.y - sim.spawn.y < 300) continue;
    const n = sim.needs.get(id);
    if (n) n.morale = Math.max(0, n.morale - 2);
  }
  // Phobia: Open Spaces pass — being in a room larger than ~10×10
  // tiles costs morale (GDD §6.5). Counts cavity area, not bounding
  // rect, so a long thin corridor doesn't trigger.
  for (const id of ents) {
    const dw = sim.dwarf.get(id);
    if (!dw || !effectsFor(dw.traitIds).phobiaOpen) continue;
    const pos = sim.position.get(id);
    if (!pos) continue;
    let inLargeRoom = false;
    for (const b of sim.planner.blueprints) {
      if (b.status !== "complete") continue;
      if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
      if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
      if (b.cavity.length > 100) inLargeRoom = true;
      break;
    }
    if (!inLargeRoom) continue;
    const n = sim.needs.get(id);
    if (n) n.morale = Math.max(0, n.morale - 2);
  }
  // Empathetic pass — morale drifts toward the average of nearby
  // dwarves' moods. Single-pass: read everyone's current morale,
  // compute deltas, then write. (Snapshotting first keeps the math
  // order-independent so it's deterministic.)
  const empaths: EntityId[] = [];
  for (const id of ents) {
    const dw = sim.dwarf.get(id);
    if (!dw || !effectsFor(dw.traitIds).empathetic) continue;
    empaths.push(id);
  }
  if (empaths.length > 0) {
    const moraleSnapshot = new Map<EntityId, number>();
    for (const id of ents) {
      const n = sim.needs.get(id);
      if (n) moraleSnapshot.set(id, n.morale);
    }
    for (const id of empaths) {
      const pos = sim.position.get(id);
      if (!pos) continue;
      let sum = 0; let count = 0;
      for (const other of ents) {
        if (other === id) continue;
        const op = sim.position.get(other);
        if (!op) continue;
        const dx = op.x - pos.x;
        const dy = op.y - pos.y;
        if (dx * dx + dy * dy > LEADER_AURA_RADIUS * LEADER_AURA_RADIUS) continue;
        const m = moraleSnapshot.get(other);
        if (m === undefined) continue;
        sum += m; count++;
      }
      if (count === 0) continue;
      const avg = sum / count;
      const my = moraleSnapshot.get(id) ?? 50;
      const drift = Math.sign(avg - my);
      const n = sim.needs.get(id);
      if (n) n.morale = Math.max(0, Math.min(100, n.morale + drift));
    }
  }
}

// ---- Engravings (GDD §7.2, §6.3 Artistry) ---------------------------
//
// "Dwarves will continue to improve rooms long after they are
// functional. A dwarf with artistic tendencies may engrave the walls
// of a finished room, adding value." Implementation: every
// ENGRAVING_INTERVAL ticks, any Skilled+ Artistry dwarf standing in
// a complete maintainable room nudges that room's quality up. Award
// Artistry XP for the work, gated on real Artistry skill so a Novice
// can't engrave their way to legend.

const ENGRAVING_INTERVAL_TICKS = 60; // once per in-game hour
const ENGRAVING_MIN_SKILL = 9; // Skilled or higher

function engravingSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % ENGRAVING_INTERVAL_TICKS !== 0) return;
  for (const id of sim.dwarf.entities) {
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const artistry = dw.skills.artistry ?? 1;
    if (artistry < ENGRAVING_MIN_SKILL) continue;
    const pos = sim.position.get(id);
    if (!pos) continue;
    // Find a complete maintainable room they're standing in. Quality
    // creeps up by 1 per tick, faster for Legendary artists.
    for (const b of sim.planner.blueprints) {
      if (b.status !== "complete") continue;
      if (!isMaintainable(b.kind)) continue;
      if (pos.x < b.originX || pos.x >= b.originX + b.width) continue;
      if (pos.y < b.originY || pos.y >= b.originY + b.height) continue;
      const cur = b.quality ?? QUALITY_BASE;
      const bump = artistry >= 17 ? 2 : 1;
      b.quality = Math.min(QUALITY_MAX, cur + bump);
      awardSkillXp(sim, id, "artistry", 1);
      break;
    }
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
    sim.regions.invalidate();
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
const TRADE_BASE_GAIN = 50;

/** Names the caravan-origin kingdoms cycle through. The chronicle
 * pulls from this pool deterministically per call so a player who
 * watches their event log over years sees recurring trade partners
 * rather than an interchangeable parade of "a caravan". */
const CARAVAN_KINGDOMS: ReadonlyArray<string> = [
  "the western kingdoms",
  "the Iron Vaults of Karnesh",
  "the Hold of Stoneholm",
  "the Bronze Reach",
  "Old Drumheim",
  "the Free Mountain Confederacy",
  "the Wandering Hammers guild",
  "the Black Coal Cantons",
];

/** Goods the colony can offer to a visiting caravan, ordered by
 * preference: surplus accumulators first, raw resources last.
 * Caravans accept whichever offered good the colony has the most of
 * (above a minimum), so a fortress with a Mason's Workshop trades
 * blocks instead of stone. */
type TradeOffer = { resource: keyof import("./world/simWorld").Stockpile; price: number; min: number };
const TRADE_OFFERS: TradeOffer[] = [
  { resource: "cut_gems", price: 8, min: 3 },   // most valuable per unit
  { resource: "blocks", price: 4, min: 8 },
  { resource: "bars", price: 5, min: 6 },
  { resource: "tools", price: 7, min: 4 },
  { resource: "leather", price: 3, min: 8 },
  { resource: "cloth", price: 3, min: 8 },
  { resource: "pots", price: 2, min: 8 },
  { resource: "planks", price: 2, min: 12 },
  { resource: "gems", price: 4, min: 4 },
  { resource: "ore", price: 2, min: 15 },
  { resource: "stone", price: 1, min: 30 }, // legacy fallback
];

/** Goods caravans bring in exchange. Picked by what the colony is
 * lowest on. */
type TradeImport = "food" | "drink" | "tools" | "rope";

/** How long a caravan lingers at the depot once it arrives. The
 * trade transaction resolves on arrival; the visual trader stays for
 * a day's worth of in-game wandering so the player can actually see
 * the caravan in the world. */
const CARAVAN_STAY_TICKS = TICKS_PER_DAY;

function tradeSystem(sim: SimWorld): void {
  // Despawn any caravan whose stay has elapsed and write a sendoff
  // line to the chronicle so the player can see the visit end as
  // well as begin.
  if (sim.caravanLeavesTick > 0 && sim.tick >= sim.caravanLeavesTick) {
    if (sim.caravanOrigin) {
      sim.events.add(
        sim.tick,
        "social",
        `The caravan from ${sim.caravanOrigin} packs its wagons and rolls back out the gate.`,
      );
    }
    sim.caravanLeavesTick = -1;
    sim.caravanOrigin = "";
  }
  if (sim.tick === 0) return;
  if (sim.tick % TRADE_INTERVAL_TICKS !== 0) return;
  if (sim.emergency.mode === "lockdown") return;
  // Seasonal arrival roll: winter cancels most caravans (snowed in),
  // summer brings extras, spring/autumn baseline.
  const season = seasonOf(sim.tick);
  const arrivalChance =
    season === "winter" ? 0.3 :
    season === "summer" ? 1.0 :
    0.85;
  if (sim.aiRng.nextFloat() >= arrivalChance) {
    if (season === "winter") {
      sim.events.add(
        sim.tick,
        "social",
        `Heavy snow on the slopes — no caravan reaches the gate this season.`,
      );
    }
    return;
  }
  // Need an active Trade Depot. Find its centre while we're at it so
  // the visible trader can park there.
  let depot: { cx: number; cy: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind === "trade_depot" && b.status === "complete") {
      depot = {
        cx: b.originX + Math.floor(b.width / 2),
        cy: b.originY + Math.floor(b.height / 2),
      };
      break;
    }
  }
  if (!depot) return;
  // Pick a kingdom of origin deterministically — the aiRng's next
  // draw rotates the pool so a watcher sees variety.
  const kingdom = CARAVAN_KINGDOMS[sim.aiRng.nextRange(0, CARAVAN_KINGDOMS.length)];
  // Park the caravan at the depot's centre. The renderer reads this
  // and draws a trader pip there until caravanLeavesTick elapses.
  sim.caravanX = depot.cx;
  sim.caravanY = depot.cy;
  sim.caravanLeavesTick = sim.tick + CARAVAN_STAY_TICKS;
  sim.caravanOrigin = kingdom;
  // Pick the offered good: the highest-stocked one above its
  // minimum threshold. Falls back to stone when nothing else
  // qualifies — that's the early-game caravan.
  let offer: TradeOffer | null = null;
  for (const o of TRADE_OFFERS) {
    if ((sim.stockpile[o.resource] ?? 0) >= o.min) {
      offer = o;
      break;
    }
  }
  if (!offer) {
    sim.events.add(
      sim.tick,
      "social",
      `A caravan from ${kingdom} arrives, but the colony has nothing worth trading. They depart empty-handed.`,
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
  // Pick what to import: the colony's lowest-stocked staple. Rope is
  // a rare delivery — only when food/drink are amply stocked AND the
  // colony has researched textile work (otherwise rope is useless to
  // them).
  const foodLow = sim.stockpile.food < 200;
  const drinkLow = sim.stockpile.drink < 200;
  let importKind: TradeImport;
  if (foodLow && (!drinkLow || sim.stockpile.food <= sim.stockpile.drink)) importKind = "food";
  else if (drinkLow) importKind = "drink";
  else if (sim.research.completed.includes("rope_and_fibre") && sim.stockpile.rope < 20) importKind = "rope";
  else importKind = "tools";
  // Broker bonus: each level above 1 adds 4% to the gain.
  const brokerDw = bestBroker !== -1 ? sim.dwarf.get(bestBroker) : undefined;
  const tradeBonus = brokerDw ? effectsFor(brokerDw.traitIds).tradeBonus : 0;
  const brokerBonus = (1 + Math.max(0, bestSkill - 1) * 0.04) * (1 + tradeBonus);
  // The deal. Spend `min` units of the offered good at price-per-unit
  // for `min * price * brokerBonus` worth of imports — scaled to
  // TRADE_BASE_GAIN's tuning so an early stone caravan still feels
  // like a meaningful exchange.
  const cost = offer.min;
  const grossValue = cost * offer.price;
  const gain = Math.round(grossValue * brokerBonus * (TRADE_BASE_GAIN / 30));
  sim.stockpile[offer.resource] -= cost;
  sim.stockpile[importKind] += gain;
  // Award XP to the broker.
  if (bestBroker !== -1) awardSkillXp(sim, bestBroker, "trading", 1);
  const brokerName = bestBroker !== -1 ? sim.dwarf.get(bestBroker)?.name ?? "the broker" : "the broker";
  sim.events.add(
    sim.tick,
    "social",
    `A caravan from ${kingdom} arrives at the Trade Depot. ${brokerName} negotiates ${gain} ${importKind} for ${cost} ${offer.resource}.`,
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
      let weaponQuality = 0;
      // Look for the highest-quality tool on a rack — a Masterwork
      // sword goes to a soldier before a basic one (GDD §6.3).
      const ents = sim.item.entities;
      let bestEnt = -1;
      let bestQ = -1;
      for (let i = 0; i < ents.length; i++) {
        const ie = ents[i];
        const it = sim.item.get(ie);
        const p = sim.position.get(ie);
        if (!it || !p) continue;
        if (it.kind !== "tools") continue;
        if (sim.grid.getTile(p.x, p.y) !== TileType.ArmouryRack) continue;
        const q = it.quality ?? 0;
        if (q > bestQ) { bestQ = q; bestEnt = ie; }
      }
      if (bestEnt !== -1) {
        weaponQuality = bestQ;
        sim.destroyItem(bestEnt);
        armed = true;
      }
      if (!armed && sim.stockpile.tools > 0) {
        // Counter fallback can't preserve quality — bars and tools in
        // the global counter are mixed grade. Treat as basic.
        sim.stockpile.tools--;
        armed = true;
      }
      if (armed) {
        sim.equipment.set(c.id, { weapon: true, weaponQuality });
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
  // Door bar/unbar transitions: when we enter lockdown, every Door
  // becomes a DoorBarred (non-walkable); when we leave, the reverse.
  // doorsBarred tracks the last applied state so we only sweep the
  // grid on transitions.
  const wantBarred = e.mode === "lockdown";
  if ((sim as { _doorsBarred?: boolean })._doorsBarred !== wantBarred) {
    (sim as { _doorsBarred?: boolean })._doorsBarred = wantBarred;
    sweepDoors(sim, wantBarred);
  }
}

function sweepDoors(sim: SimWorld, barred: boolean): void {
  const from = barred ? TileType.Door : TileType.DoorBarred;
  const to = barred ? TileType.DoorBarred : TileType.Door;
  const grid = sim.grid;
  let changed = false;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.getTile(x, y) === from) {
        grid.setTile(x, y, to);
        changed = true;
      }
    }
  }
  if (changed) sim.regions.invalidate();
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
    const id = dwarves[i];
    const pos = sim.position.get(id);
    if (!pos) continue;
    // Eagle-Eyed dwarves see further into the fog (GDD §6.5).
    const dw = sim.dwarf.get(id);
    const r = dw ? effectsFor(dw.traitIds).visibilityRadius : VISIBILITY_RADIUS;
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

/** Tavern visits: once per in-game day, every dwarf below MORALE_HIGH
 * picks up a small morale boost from time spent at the colony's
 * tavern. Skipped while shelter modes are active — nobody drinks
 * during an alarm. */
const TAVERN_TICK_INTERVAL = TICKS_PER_DAY;
const TAVERN_VISIT_BUMP = 5;
const TAVERN_VISIT_CAP = 90;
function tavernSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TAVERN_TICK_INTERVAL !== 0) return;
  // Leadership XP: once per in-game day, the dwarf with the highest
  // leadership skill earns one practice-tick. The skill represents the
  // colony's informal captaincy — quartermaster, foreman, the dwarf
  // whose word carries weight at the dining hall — so it grows with
  // time spent leading. This fires regardless of whether a tavern
  // exists; even shelter modes don't suspend it.
  let bestLeader: EntityId = -1;
  let bestLeaderSkill = 0;
  const dEnts = sim.dwarf.entities;
  for (let i = 0; i < dEnts.length; i++) {
    const id = dEnts[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const skill = dw.skills.leadership ?? 1;
    if (bestLeader === -1 || skill > bestLeaderSkill || (skill === bestLeaderSkill && id < bestLeader)) {
      bestLeader = id;
      bestLeaderSkill = skill;
    }
  }
  if (bestLeader !== -1) awardSkillXp(sim, bestLeader, "leadership", 1);

  if (sim.emergency.mode === "alarm" || sim.emergency.mode === "evacuate") return;
  let hasTavern = false;
  for (const b of sim.planner.blueprints) {
    if (b.kind === "tavern" && b.status === "complete") {
      hasTavern = true;
      break;
    }
  }
  if (!hasTavern) return;
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const n = sim.needs.get(e);
    if (!n) continue;
    if (n.morale >= TAVERN_VISIT_CAP) continue;
    n.morale = Math.min(TAVERN_VISIT_CAP, n.morale + TAVERN_VISIT_BUMP);
  }
}

/** Legendary brewer + Legendary artist specialties (GDD §6.3): once
 * per in-game season the colony fires a Reserve Ale event if a
 * Legendary brewer is on staff with a brewery, or a Magnum Opus event
 * if a Legendary artist is in the fortress. Cooldown is per-event so
 * both can fire in the same season. */
const LEGENDARY_SPECIALTY_INTERVAL = TICKS_PER_DAY * 30; // a season = 30 in-game days
const LEGENDARY_THRESHOLD = 17;
function legendarySpecialtiesSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % LEGENDARY_SPECIALTY_INTERVAL !== 0) return;
  // Reserve Ale: Legendary brewer + complete brewery → fortress-wide
  // morale bump and a chronicle entry. The colony's drink stockpile
  // also gets a sizeable cask delivery.
  const reserveBrewer = findLegendaryDwarf(sim, "brewing");
  const hasBrewery = sim.planner.blueprints.some((b) => b.kind === "brewery" && b.status === "complete");
  if (reserveBrewer !== -1 && hasBrewery) {
    const dw = sim.dwarf.get(reserveBrewer);
    sim.stockpile.drink += 50;
    bumpAllMorale(sim, 8);
    if (dw) {
      sim.events.add(
        sim.tick,
        "social",
        `${dw.name} pulls a Reserve Ale from the cellar. The colony toasts a barrel that has been waiting all season.`,
      );
    }
  }
  // Magnum Opus: Legendary artist anywhere in the fortress → a
  // morale-defining work of art lands in the chronicle.
  const magnumArtist = findLegendaryDwarf(sim, "artistry");
  if (magnumArtist !== -1) {
    const dw = sim.dwarf.get(magnumArtist);
    bumpAllMorale(sim, 12);
    if (dw) {
      sim.events.add(
        sim.tick,
        "social",
        `${dw.name} unveils a Magnum Opus — a work of art the colony will speak of for generations.`,
      );
    }
  }
}

function findLegendaryDwarf(sim: SimWorld, skill: SkillId): EntityId {
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const dw = sim.dwarf.get(e);
    if (!dw) continue;
    if ((dw.skills[skill] ?? 1) >= LEGENDARY_THRESHOLD) return e;
  }
  return -1;
}

function bumpAllMorale(sim: SimWorld, amount: number): void {
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const n = sim.needs.get(ents[i]);
    if (!n) continue;
    n.morale = Math.min(100, n.morale + amount);
  }
}

function farmSystem(sim: SimWorld): void {
  if (sim.tick % FARM_TICK_INTERVAL !== 0) return;
  // Underground Agriculture (Tier 2): once researched, the farm yield
  // chance climbs 50%. The same untended-cell rule still applies, so
  // the boost only lands where the colony's actually doing the work.
  const undergroundAg = sim.research.completed.includes("underground_agriculture");
  // Seasonal yield modifier: even underground farms feel the year
  // through warmth, daylight bleeding through the entrance shaft,
  // and the colony's own rhythms. Spring/summer above 1.0×, winter
  // well below.
  const season = seasonOf(sim.tick);
  const seasonScale =
    season === "spring" ? 1.1 :
    season === "summer" ? 1.2 :
    season === "autumn" ? 0.9 :
    0.5; // winter
  const yieldChance = FARM_YIELD_CHANCE * (undergroundAg ? 1.5 : 1) * seasonScale;
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
      if (sim.aiRng.nextFloat() < yieldChance) {
        // Drop a raw food item on the cell. A hauler routes it to a
        // kitchen (cooked meals), brewery (ale), or stockpile in
        // priority order. Cap stacking on a single cell so an
        // un-hauled farm doesn't grow a tower of food entities.
        if (countItemsAt(sim, x, y, "food") < 4) {
          sim.spawnItem({ kind: "food", x, y });
        }
      }
      // Occasional fibre yield: cave plants ribbon the deeper farm
      // cavities with stringy fungal threads the colony spins into
      // rope. Goes straight to the stockpile counter — no item entity,
      // no hauling. Rate is a quarter the food yield so rope stays
      // scarce relative to ale and meals.
      if (sim.aiRng.nextFloat() < FARM_YIELD_CHANCE * 0.25) {
        sim.stockpile.rope++;
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
  // Burial: if a Cemetery exists with an empty Grave plot, mark a
  // Headstone there and register the dead dwarf in the colony's
  // gravestones registry. The Memorial tile on the spot they fell
  // still stays (the place they fell is its own kind of marker), but
  // the cemetery is where survivors visit.
  buryDwarf(sim, dw, age, cause);
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
      // Bereavement morale hit, scaled by traits — Loyal grieves
      // hard, Fickle barely notices (GDD §6.5).
      const partnerNeeds = sim.needs.get(dw.partnerId);
      if (partnerNeeds) {
        const scale = effectsFor(partner.traitIds).bereavementScale;
        const hit = Math.round(15 * scale);
        partnerNeeds.morale = Math.max(0, partnerNeeds.morale - hit);
      }
      partner.partnerId = null;
    }
  }
  // If the dwarf was carrying something, drop it on the death tile so a
  // teammate can finish the haul. Releases any item claim implicitly via
  // the alive-check in findHaulTarget.
  const carrying = sim.carrying.get(e);
  if (carrying) {
    sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y, quality: carrying.quality });
  }
  // Remove from the ECS, which strips all component stores.
  sim.ecs.destroy(e, [sim.position, sim.dwarf, sim.pathing, sim.job, sim.needs, sim.health, sim.carrying, sim.squad, sim.equipment, sim.fury, sim.obsession]);
}

/** Find an empty Grave plot in any complete Cemetery and turn it
 * into a Headstone holding this dwarf's record. The colony's
 * `graves` registry stores the deceased's details so the chronicle
 * + future visit-grave job can reference them. Falls through quietly
 * if no cemetery exists or every plot is already filled — the
 * Memorial tile on the death spot is still there as a fallback. */
function buryDwarf(sim: SimWorld, dw: import("./ecs/components").Dwarf, age: number, cause: string): void {
  let plot: { x: number; y: number } | null = null;
  outer: for (const b of sim.planner.blueprints) {
    if (b.kind !== "cemetery" || b.status !== "complete") continue;
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      if (sim.grid.getTile(x, y) === TileType.Grave) {
        plot = { x, y };
        break outer;
      }
    }
  }
  if (!plot) return;
  sim.grid.setTile(plot.x, plot.y, TileType.Headstone);
  sim.graves.push({
    x: plot.x,
    y: plot.y,
    name: dw.name,
    profession: dw.profession,
    ageAtDeath: age,
    deathTick: sim.tick,
    cause,
  });
  // If this dwarf had a partner who's still alive, record the grave
  // location on the survivor so chooseTask can route them to pay
  // respects when their morale dips. The partnerId reference is
  // already cleared by the bereavement branch above; we passed `dw`
  // (the deceased's component) into this helper so the partnerId
  // there is the survivor's id.
  if (dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId)) {
    const partner = sim.dwarf.get(dw.partnerId);
    if (partner) partner.lostPartnerGrave = { x: plot.x, y: plot.y };
  }
  sim.events.add(
    sim.tick,
    "social",
    `${dw.name} is laid to rest in the cemetery. Aged ${age} years.`,
  );
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
  // Obsessive: 2× XP gain on the fixation skill (GDD §6.5).
  const ob = sim.obsession.get(e);
  if (ob && ob.skillId === skill) amount *= 2;
  // Mentoring (GDD §6.1 elder phase): a young dwarf earning XP in a
  // skill gets a small boost when an elder in the same skill is in
  // the colony. Caps at 1.25× so the elders matter without trivialising
  // the grind.
  const learnerAge = sim.ageOf(e);
  if (learnerAge < 30 && (dw.skills[skill] ?? 1) < 13) {
    if (hasElderMentor(sim, skill)) amount *= 1.25;
  }
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

const SEASON_NARRATION: Record<Season, string> = {
  spring: "Spring returns to the mountain. Surface meltwater drips from the entrance shaft.",
  summer: "Summer sets in. The surface clearing turns gold; caravans roll more often.",
  autumn: "Autumn comes to the slopes. The surface trees redden; the harvest is brought in.",
  winter: "Winter sets in. Snow buries the surface; few caravans reach the gate.",
};

/** Quarterly season-rollover beat: when the tick crosses a season
 * boundary, log the seasonal arrival. The active season is otherwise
 * derived from sim.tick via seasonOf — no per-frame state to keep in
 * sync — so this system only fires the chronicle line. */
function seasonRolloverSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TICKS_PER_SEASON !== 0) return;
  const s = seasonOf(sim.tick);
  sim.events.add(sim.tick, "milestone", SEASON_NARRATION[s]);
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
    // Trait-driven scaling — Focused dwarves resist interruption,
    // Distractible ones flake at the slightest twinge or for no
    // reason at all (GDD §6.5).
    const job = sim.job.get(e);
    if (job) {
      const needs = sim.needs.get(e);
      const dw = sim.dwarf.get(e);
      const eff = dw ? effectsFor(dw.traitIds) : null;
      const scale = eff?.interruptScale ?? 1;
      const tHi = INTERRUPT_THIRST * scale;
      const hHi = INTERRUPT_HUNGER * scale;
      const survivalKind =
        job.kind === "eat" || job.kind === "drink" || job.kind === "sleep" || job.kind === "shelter";
      let interrupt = false;
      if (
        needs &&
        !survivalKind &&
        ((needs.thirst <= tHi && sim.stockpile.drink > 0) ||
          (needs.hunger <= hHi && (sim.stockpile.food > 0 || sim.stockpile.meals > 0)))
      ) {
        interrupt = true;
      }
      // Distractible: a small chance per tick to abandon a non-
      // survival job for no need-driven reason. Deterministic via aiRng.
      if (
        !interrupt &&
        !survivalKind &&
        eff && eff.distractChance > 0 &&
        sim.aiRng.nextFloat() < eff.distractChance
      ) {
        interrupt = true;
      }
      if (interrupt) {
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

    // Sub-tick movement budget (GDD §6.5 Agile / Slow). Default
    // moveSpeed=1 means a step every tick exactly. Agile (1.2)
    // squeezes in an extra step every 5 ticks; Slow (0.8) skips one.
    const dw = sim.dwarf.get(e);
    const moveSpeed = dw ? effectsFor(dw.traitIds).moveSpeed : 1;
    const accum = (path.moveAccum ?? 0) + moveSpeed;
    if (accum < 1) {
      path.moveAccum = accum;
      continue;
    }
    path.moveAccum = accum - 1;
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
      case "visit_grave":
        progressVisitGrave(sim, e, job, pos);
        break;
    }
  }
}

/** Stand at a buried partner's headstone for a measured moment of
 * mourning. Morale ticks up a small amount — grief processed in
 * proximity to the dead — and the chronicle records the visit on
 * arrival. The dwarf moves on after the visit completes. */
const VISIT_GRAVE_TICKS = 60; // one in-game hour
const VISIT_GRAVE_MORALE_BUMP = 8;
function progressVisitGrave(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  const dx = Math.abs(pos.x - job.targetX);
  const dy = Math.abs(pos.y - job.targetY);
  if (dx > 1 || dy > 1) {
    // Not yet adjacent — pathing system is still walking us. Wait.
    return;
  }
  const tile = sim.grid.getTile(job.targetX, job.targetY);
  if (tile !== TileType.Headstone) {
    // Grave got dug up or the cemetery was destroyed somehow. Bail.
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  if (job.progress === 0) {
    // First tick — log the visit. Look up the buried name from the
    // colony registry so the line reads as personal rather than
    // generic.
    const dw = sim.dwarf.get(e);
    let buriedName: string | null = null;
    for (const g of sim.graves) {
      if (g.x === job.targetX && g.y === job.targetY) {
        buriedName = g.name;
        break;
      }
    }
    if (dw && buriedName) {
      sim.events.add(
        sim.tick,
        "social",
        `${dw.name} stands at ${buriedName}'s grave for a long while. The mountain is quiet.`,
      );
    }
  }
  job.progress++;
  if (job.progress >= VISIT_GRAVE_TICKS) {
    const needs = sim.needs.get(e);
    if (needs) {
      needs.morale = Math.min(100, needs.morale + VISIT_GRAVE_MORALE_BUMP);
    }
    const dw = sim.dwarf.get(e);
    if (dw) dw.lastGraveVisitTick = sim.tick;
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
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
    sim.regions.invalidate();
  }
  // Operating the pump is engineering work — credit the skill so a
  // dedicated pump-jockey actually levels up over months of flood
  // duty. Pumps are the only engineering job for now; future
  // mechanisms (drawbridges, traps) wire in here too.
  awardSkillXp(sim, e, "engineering", 1);
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
  const traitSpeed = effectiveWorkSpeed(sim, e);
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
    // Steel Alloying (Tier 2) lifts the smelter's bar yield from 1 to
    // 2 per ore — the colony has learned to fold its bars properly.
    let outputQty = recipe.outputQty;
    if (blueprintKind === "smelter" && sim.research.completed.includes("steel_alloying")) {
      outputQty *= 2;
    }
    const outAsItem = outputAsItemKind(recipe.outputKind);
    if (outAsItem) {
      // Roll output quality from the crafter's skill — Skilled+ smiths
      // produce Fine bars, Legendary smiths produce Masterworks (GDD §6.3).
      // A Perfectionist's roll lands one tier higher.
      const traitBias = dw ? effectsFor(dw.traitIds).qualityBias : 0;
      // Elders craft to a higher tier — the slower-but-wiser side of
      // the GDD §6.1 lifecycle. +1 quality on every output.
      const elderBias = isElder(sim, e) ? 1 : 0;
      // Research-driven quality bonuses: Tier-3 Weaponsmithing lifts
      // forge output by a full tier, Tier-4 Advanced Metallurgy adds
      // another to smelter and forge bars. Stacking is intentional —
      // a dwarf at the legendary forge with both topics complete
      // produces masterworks the same way an elder does.
      let researchBias = 0;
      const completed = sim.research.completed;
      if ((blueprintKind === "forge" || blueprintKind === "magma_forge") && completed.includes("weaponsmithing")) researchBias++;
      if ((blueprintKind === "forge" || blueprintKind === "magma_forge" || blueprintKind === "smelter") && completed.includes("advanced_metallurgy")) researchBias++;
      // Magma Forge by definition stamps an extra quality tier on
      // every output — that's the "magma forge craft" of the GDD's
      // Tier 4 research arc, the metallurgical jump that makes the
      // Hollow King ultimately killable.
      if (blueprintKind === "magma_forge") researchBias++;
      const baseQuality = rollCraftQuality(sim, dw?.skills[recipe.skill] ?? 1);
      const quality = Math.max(0, Math.min(4, baseQuality + traitBias + elderBias + researchBias));
      for (let i = 0; i < outputQty; i++) {
        sim.spawnItem({ kind: outAsItem, x: pos.x, y: pos.y, quality });
      }
      // Notable artifact roll: a Legendary maker (skill ≥ 17) producing
      // a Masterwork (q=4) names the result with some probability. The
      // chronicle records it; the colony's history collects it.
      if (quality === 4 && dw && (dw.skills[recipe.skill] ?? 1) >= LEGENDARY_THRESHOLD) {
        if (sim.aiRng.nextFloat() < ARTIFACT_NAMING_CHANCE) {
          coinArtifact(sim, dw, outAsItem, recipe.skill);
        }
      }
    } else {
      sim.stockpile[recipe.outputKind] += outputQty;
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

/** Artifact naming: how often a Masterwork from a Legendary maker
 * gets named. Lower than 1.0 so most Masterworks pass without fanfare
 * and the named ones feel like rare events worth bragging about. */
const ARTIFACT_NAMING_CHANCE = 0.4;

/** Adjective + noun pools for the artifact name generator. The maker
 * picks a name that fits the item kind, then a fortress-affiliated
 * tail when the colony has the surplus to spare. */
const ARTIFACT_ADJECTIVES: ReadonlyArray<string> = [
  "Storm", "Iron", "Deep", "Hollow", "Crown", "First", "Last", "Eternal",
  "Forge", "Stone", "Frost", "Sun", "Moon", "Dawn", "Dusk", "Far",
  "Old", "Bright", "Quiet", "Sharp", "Silent", "Burning", "Singing",
];
const ARTIFACT_NOUNS_TOOL: ReadonlyArray<string> = [
  "Breaker", "Hammer", "Pick", "Splitter", "Edge", "Bite", "Tooth", "Fang",
  "Cleaver", "Maul",
];
const ARTIFACT_NOUNS_BAR: ReadonlyArray<string> = [
  "Ingot", "Crown", "Gleam", "Shine", "Heart",
];
const ARTIFACT_NOUNS_GEM: ReadonlyArray<string> = [
  "Star", "Tear", "Eye", "Heart", "Light", "Dream",
];
const ARTIFACT_NOUNS_BLOCK: ReadonlyArray<string> = [
  "Cornerstone", "Foundation", "Standard", "Hold", "Anchor",
];
const ARTIFACT_NOUNS_PLANK: ReadonlyArray<string> = [
  "Stave", "Beam", "Bone", "Mast", "Spar",
];
const ARTIFACT_NOUNS_FALLBACK: ReadonlyArray<string> = [
  "Mark", "Token", "Sign", "Pride",
];

const ARTIFACT_KIND_LABELS: Record<string, string> = {
  tools: "tool",
  bars: "bar",
  cut_gems: "cut gem",
  gem: "rough gem",
  blocks: "stone block",
  planks: "plank",
  wood: "log",
  meal: "ceremonial dish",
  drink: "vintage cask",
  hide: "tanned hide",
  ore: "ore vein-piece",
  stone: "stoneworking",
  dirt: "earthwork",
  food: "preserve",
};

function pickArtifactNoun(rng: import("./rng").Rng, itemKind: string): string {
  let pool = ARTIFACT_NOUNS_FALLBACK;
  if (itemKind === "tools") pool = ARTIFACT_NOUNS_TOOL;
  else if (itemKind === "bars") pool = ARTIFACT_NOUNS_BAR;
  else if (itemKind === "gem" || itemKind === "cut_gems") pool = ARTIFACT_NOUNS_GEM;
  else if (itemKind === "blocks") pool = ARTIFACT_NOUNS_BLOCK;
  else if (itemKind === "planks" || itemKind === "wood") pool = ARTIFACT_NOUNS_PLANK;
  return pool[rng.nextRange(0, pool.length)];
}

/** Coin a name for the Masterwork the dwarf just produced and add
 * an entry to the colony's artifact registry. The chronicle gets a
 * one-line announcement; future displays (throne room, inspector)
 * read from sim.artifacts. */
function coinArtifact(sim: SimWorld, dw: import("./ecs/components").Dwarf, itemKind: string, skill: import("./dwarves/skills").SkillId): void {
  const adj = ARTIFACT_ADJECTIVES[sim.aiRng.nextRange(0, ARTIFACT_ADJECTIVES.length)];
  const noun = pickArtifactNoun(sim.aiRng, itemKind);
  const name = `${adj}${noun}`;
  const kindLabel = ARTIFACT_KIND_LABELS[itemKind] ?? "artifact";
  const id = sim.artifactsNextId++;
  sim.artifacts.push({
    id,
    name,
    kindLabel,
    makerName: dw.name,
    makerProfession: dw.profession,
    createdTick: sim.tick,
  });
  sim.events.add(
    sim.tick,
    "milestone",
    `${dw.name} the ${dw.profession} forges ${name}, a ${kindLabel} of legendary ${skill}.`,
  );
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
  if (resource === "wood") return "wood";
  if (resource === "hide") return "hide";
  return null;
}

/** Age (in years) at which a dwarf enters the Elder phase — slower
 * but wiser per GDD §6.1. Elders craft to a higher tier on average
 * but lose a notch of work speed. */
const ELDER_AGE = 90;

function isElder(sim: SimWorld, e: EntityId): boolean {
  return sim.ageOf(e) >= ELDER_AGE;
}

/** True iff there's a living Elder in the colony at Skilled+ in the
 * given skill. Mentoring boost in awardSkillXp gates on this so the
 * elder phase actually transmits expertise to the next generation. */
function hasElderMentor(sim: SimWorld, skill: SkillId): boolean {
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    if (sim.ageOf(id) < ELDER_AGE) continue;
    if ((dw.skills[skill] ?? 1) >= 9) return true; // Skilled or higher
  }
  return false;
}

/** Trait-modulated work speed at the current in-game hour. Folds in
 * the static trait workSpeed plus any time-of-day flags (Night Owl
 * gets full speed at night, 0.8× during the day per GDD §6.5), the
 * elder slowdown, and a power-driven boost from a nearby water wheel. */
function effectiveWorkSpeed(sim: SimWorld, dwarfId: EntityId): number {
  const dw = sim.dwarf.get(dwarfId);
  if (!dw) return 1;
  const eff = effectsFor(dw.traitIds);
  let speed = eff.workSpeed;
  if (eff.nightOwl) {
    const hour = (sim.tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    const isNight = hour < 6 || hour >= 22;
    speed *= isNight ? 1.0 : 0.8;
  }
  if (isElder(sim, dwarfId)) {
    speed *= 0.85;
  }
  // Water Wheel aura: a wheel within 8 tiles of the worker adds 30%
  // to the effective work speed. The GDD's "mechanical power" without
  // a full power-grid system. Multiple wheels don't stack — one is
  // enough, the colony's wired up.
  const pos = sim.position.get(dwarfId);
  if (pos && hasNearbyWaterWheel(sim, pos.x, pos.y)) speed *= 1.3;
  return speed;
}

/** Best available pickaxe quality in the colony (0 = basic, 4 =
 * Masterwork). The miner uses whichever forged tool is highest-tier
 * — they share a tool pool informally, no per-dwarf equipment.
 * Falls back to 0 (a stone pick) when no metal tools have been
 * forged yet. Mid-tick scan is fast: typical fortresses carry only
 * a handful of tool items at once. */
function colonyToolQuality(sim: SimWorld): number {
  let best = 0;
  // Scan tool items in the world (on the floor, on armoury racks,
  // or being carried mid-haul).
  const ents = sim.item.entities;
  for (let i = 0; i < ents.length; i++) {
    const it = sim.item.get(ents[i]);
    if (!it || it.kind !== "tools") continue;
    const q = it.quality ?? 0;
    if (q > best) best = q;
  }
  // A dwarf carrying a tool counts too — they'll let a miner borrow it.
  const carryEnts = sim.carrying.entities;
  for (let i = 0; i < carryEnts.length; i++) {
    const c = sim.carrying.get(carryEnts[i]);
    if (!c || c.kind !== "tools") continue;
    const q = c.quality ?? 0;
    if (q > best) best = q;
  }
  // Equipped soldiers: their weapon is a forged tool too.
  const eqEnts = sim.equipment.entities;
  for (let i = 0; i < eqEnts.length; i++) {
    const eq = sim.equipment.get(eqEnts[i]);
    if (!eq || !eq.weapon) continue;
    const q = eq.weaponQuality ?? 0;
    if (q > best) best = q;
  }
  return best;
}

const WATER_WHEEL_AURA = 8;
function hasNearbyWaterWheel(sim: SimWorld, sx: number, sy: number): boolean {
  for (let dy = -WATER_WHEEL_AURA; dy <= WATER_WHEEL_AURA; dy++) {
    for (let dx = -WATER_WHEEL_AURA; dx <= WATER_WHEEL_AURA; dx++) {
      if (dx * dx + dy * dy > WATER_WHEEL_AURA * WATER_WHEEL_AURA) continue;
      if (sim.grid.getTile(sx + dx, sy + dy) === TileType.WaterWheel) return true;
    }
  }
  return false;
}

/** Roll a quality tier (0..4: basic / Fine / Superior / Exceptional /
 * Masterwork) for a crafted item from the crafter's skill level (GDD
 * §6.3). The distribution is intentionally generous — Skilled smiths
 * regularly turn out Fine work, Legendary ones occasionally produce
 * a Masterwork. Deterministic via aiRng. */
function rollCraftQuality(sim: SimWorld, skill: number): number {
  const r = sim.aiRng.nextFloat();
  if (skill >= 17) {
    // Legendary: regular Exceptional, chance of Masterwork.
    if (r < 0.30) return 4;
    if (r < 0.90) return 3;
    return 2;
  }
  if (skill >= 13) {
    // Expert: regular Superior, rare Exceptional.
    if (r < 0.10) return 3;
    if (r < 0.70) return 2;
    return 1;
  }
  if (skill >= 9) {
    // Skilled: regular Fine, rare Superior.
    if (r < 0.10) return 2;
    if (r < 0.70) return 1;
    return 0;
  }
  if (skill >= 5) {
    // Adequate: small chance of Fine.
    return r < 0.20 ? 1 : 0;
  }
  // Novice: baseline.
  return 0;
}

export const QUALITY_LABELS = ["basic", "Fine", "Superior", "Exceptional", "Masterwork"] as const;

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
      sim.carrying.set(e, { kind: it.kind, quality: it.quality });
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
    sim.spawnItem({ kind: carrying.kind, x: pos.x, y: pos.y, quality: carrying.quality });
    droppedAsItem = true;
    break;
  }
  if (!droppedAsItem && carrying.kind === "tools" && tile === TileType.ArmouryRack) {
    sim.spawnItem({ kind: "tools", x: pos.x, y: pos.y, quality: carrying.quality });
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
    else if (carrying.kind === "wood") sim.stockpile.wood++;
    else if (carrying.kind === "hide") sim.stockpile.hide++;
  }
  sim.carrying.remove(e);
  // Hauling earns hauling XP — every successful delivery counts as
  // practice. The Strong-Backed and Patient traits already factor into
  // movement and persistence; here we let the skill itself climb.
  awardSkillXp(sim, e, "hauling", 1);
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
  const mineSpeed = effectiveWorkSpeed(sim, e);
  job.progress += mineSpeed;
  // Material hardness + skill + pickaxe quality determine how many
  // ticks of progress are needed. Hardness is per-tile; skill scales
  // ticks down ~3% per level above novice; tool quality scales ticks
  // down 8% per quality tier so a Masterwork pickaxe roughly halves
  // the dig time on hard rock.
  const targetTile = sim.grid.getTile(job.targetX, job.targetY);
  const hardness = MATERIAL_HARDNESS[targetTile] ?? 1.0;
  const dw = sim.dwarf.get(e);
  const miningSkill = dw?.skills.mining ?? 1;
  const skillScale = Math.max(0.4, 1 - (miningSkill - 1) * 0.03);
  const toolQuality = colonyToolQuality(sim);
  const toolScale = Math.max(0.4, 1 - toolQuality * 0.08);
  const ticksNeeded = Math.max(2, Math.round(MINE_TICKS * hardness * skillScale * toolScale));
  if (job.progress >= ticksNeeded) {
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
    // Trees leave Grass behind (the surface stays surface), every other
    // mineable tile becomes a CorridorFloor. Logging awards carpentry XP
    // since the cut is the carpenter's craft, not a miner's. The wood
    // log drops as a haulable item the same way ore does.
    const postMineTile =
      tileType === TileType.Tree ? TileType.Grass : TileType.CorridorFloor;
    sim.grid.setTile(job.targetX, job.targetY, postMineTile);
    sim.grid.setDesignation(job.targetX, job.targetY, 0);
    sim.regions.invalidate();
    sim.releaseMineTarget(job.targetX, job.targetY);
    if (tileType === TileType.Tree) {
      awardSkillXp(sim, e, "carpentry", 1);
    } else {
      // Grant mining XP and announce tier crossings ("become a Skilled Miner").
      awardSkillXp(sim, e, "mining", 1);
    }

    // Drop the rock as a haulable item on the freshly-excavated tile.
    // A separate hauler job picks it up later and carries it to the
    // stockpile. The first-strike narration still fires the moment the
    // ore is broken.
    let itemKind: import("./ecs/components").ItemKind | null = null;
    if (tileType === TileType.Tree) {
      itemKind = "wood";
    } else if (tileType === TileType.Ore) {
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
    } else if (tileType === TileType.Gold) {
      itemKind = "ore";
      const dw = sim.dwarf.get(e)!;
      sim.events.add(
        sim.tick,
        "discovery",
        `${dw.name} strikes gold, ${depthPhraseFor(job.targetY, sim.spawn.y)}.`,
      );
      fireMilestone(
        sim,
        "the_gilded_halls",
        `The Gilded Halls. ${dw.name} has cut gold from the deep rock.`,
      );
    } else if (tileType === TileType.Coal) {
      // Coal drops as ore for now; future smelter / forge tiers will
      // route it as fuel separately.
      itemKind = "ore";
    } else if (tileType === TileType.CaveMushroom) {
      // Mushroom drops as food. The colony has another mouth to feed
      // and the mountain quietly answers.
      itemKind = "food";
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
    // Sleeping in a high-quality bedroom raises morale (GDD §6.4
    // Esteem). A rough cavity at QUALITY_BASE adds nothing; a
    // legendary bedroom hands a meaningful morale bump on every
    // night's rest.
    if (pos) {
      const q = roomQualityAt(sim, pos.x, pos.y, "bedroom");
      if (q > QUALITY_BASE) {
        const dw = sim.dwarf.get(e);
        const scale = dw ? effectsFor(dw.traitIds).roomQualityScale : 1;
        const bump = Math.floor((q - QUALITY_BASE) / 10 * scale);
        needs.morale = Math.min(100, needs.morale + bump);
      }
    }
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

/** Return the quality of a completed room of the given kind whose
 * cavity contains (x, y), or 0 if no such room is here. Used by
 * progressSleep / progressEat to scale morale gain by room quality
 * (GDD §6.4 Esteem). */
function roomQualityAt(sim: SimWorld, x: number, y: number, kind: string): number {
  for (const b of sim.planner.blueprints) {
    if (b.kind !== kind || b.status !== "complete") continue;
    if (x < b.originX || x >= b.originX + b.width) continue;
    if (y < b.originY || y >= b.originY + b.height) continue;
    return b.quality ?? QUALITY_BASE;
  }
  return 0;
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
    // Eating in a high-quality dining hall is a small morale lift
    // (GDD §6.4): the carved chairs, the engraved walls, the company
    // are good. A rough cavity does nothing extra.
    const pos = sim.position.get(e);
    if (pos) {
      const q = roomQualityAt(sim, pos.x, pos.y, "dining_hall");
      if (q > QUALITY_BASE) {
        const dw = sim.dwarf.get(e);
        const scale = dw ? effectsFor(dw.traitIds).roomQualityScale : 1;
        const bump = Math.floor((q - QUALITY_BASE) / 10 * scale);
        needs.morale = Math.min(100, needs.morale + bump);
      }
    }
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
    awardSkillXp(sim, e, "farming", 1);
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
      // Each maintenance pass also nudges the room's quality upward
      // (GDD §7.3). The oldest, best-kept rooms become legendary;
      // neglected ones stay rough.
      const cur = b.quality ?? QUALITY_BASE;
      b.quality = Math.min(QUALITY_MAX, cur + QUALITY_PER_MAINTAIN);
      break;
    }
  }
  job.progress++;
  if (job.progress >= MAINTAIN_TICKS) {
    // Maintenance is general upkeep — credit masonry XP, the broad
    // industry skill that matches scrubbing, fitting blocks, and
    // tidying joinery.
    awardSkillXp(sim, e, "masonry", 1);
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
const HEAL_RATE_HOSPITAL = 5; // tended wound on a hospital cot
const HEAL_RATE_BED = 3;
const HEAL_RATE_RESTING = 2; // sleeping anywhere
const HEAL_RATE_IDLE = 1;    // wandering / socialising

/** Return the entity id of the dwarf with the highest medicine skill,
 * tie-broken by entity id for determinism. -1 if no dwarves exist. */
function findBestMedic(sim: SimWorld): EntityId {
  let best: EntityId = -1;
  let bestSkill = 0;
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const dw = sim.dwarf.get(e);
    if (!dw) continue;
    const skill = dw.skills.medicine ?? 1;
    if (best === -1 || skill > bestSkill || (skill === bestSkill && e < best)) {
      best = e;
      bestSkill = skill;
    }
  }
  return best;
}

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
    let onHospitalBed = false;
    const job = sim.job.get(e);
    if (job?.kind === "sleep") {
      const tile = sim.grid.getTile(pos.x, pos.y);
      if (tile === TileType.HospitalBed) {
        healing = HEAL_RATE_HOSPITAL;
        onHospitalBed = true;
      } else if (tile === TileType.Bed) {
        healing = HEAL_RATE_BED;
      } else {
        healing = HEAL_RATE_RESTING;
      }
    } else if (!job || job.kind === "wander" || job.kind === "socialise") {
      healing = HEAL_RATE_IDLE;
    }
    // Working (mining) suspends healing — the dwarf is exerting themselves.
    if (healing === 0) continue;

    hp.hp = Math.min(hp.maxHp, hp.hp + healing);
    // Hospital tending: credit the colony's best-skilled medic with
    // medicine XP every healing tick a wound is treated on a cot.
    // The dwarf with the highest medicine skill is "on duty" — if no
    // dwarf has any medicine skill yet, none of them gains XP this
    // tick (someone has to start somewhere; running wounded through a
    // cot doesn't teach anyone medicine in the abstract).
    if (onHospitalBed) {
      const medic = findBestMedic(sim);
      if (medic !== -1 && medic !== e) awardSkillXp(sim, medic, "medicine", 1);
    }
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
  // Goblin patrols: a scout never really comes alone. With moderate
  // probability the original spawn is reinforced by 1–2 extra scouts
  // within a short radius, producing patrol formations the colony's
  // standing guard has to actually engage as a unit (GDD §9.3).
  // After Military Tactics research the patrols swell further. Gated
  // on population so a one-dwarf colony isn't crushed by a 3-goblin
  // patrol on day one — the GDD's narrative beat is that patrols
  // arrive when the colony is worth raiding.
  if (kind === "goblin_scout" && dwarves >= 6) {
    const tactics = sim.research.completed.includes("military_tactics");
    const patrolChance = tactics ? 0.85 : 0.55;
    if (sim.aiRng.nextFloat() < patrolChance) {
      const extras = (tactics ? 2 : 1) + sim.aiRng.nextRange(0, 2);
      for (let i = 0; i < extras; i++) {
        // Sample a nearby tile from the candidate set — keep them in
        // line-of-sight of the original.
        let attempts = 8;
        while (attempts-- > 0) {
          const c = candidates[sim.aiRng.nextRange(0, candidates.length)];
          const dx = c.x - pick.x;
          const dy = c.y - pick.y;
          if (dx * dx + dy * dy > 25) continue; // patrol cohesion radius
          if (c.x === pick.x && c.y === pick.y) continue;
          sim.spawnHostile({ kind, x: c.x, y: c.y });
          break;
        }
      }
    }
  }
}

/** Weighted random hostile kind. Each kind only enters the pool once
 * the colony has actually reached its minDepth — the player should see
 * a fortress at the surface get only rats, while one in the deep rock
 * starts seeing the harder kinds. */
function pickHostileKind(sim: SimWorld, deepestY: number): HostileKind {
  const reachableDepth = deepestY - sim.spawn.y;
  const eligible: HostileKind[] = ["cave_rat"]; // always available
  if (reachableDepth >= HOSTILE_DEFS.cave_bat.minDepth) eligible.push("cave_bat");
  if (reachableDepth >= HOSTILE_DEFS.cave_spider.minDepth) eligible.push("cave_spider");
  if (reachableDepth >= HOSTILE_DEFS.goblin_scout.minDepth) eligible.push("goblin_scout", "goblin_scout");
  if (reachableDepth >= HOSTILE_DEFS.cave_bear.minDepth) eligible.push("cave_bear");
  if (reachableDepth >= HOSTILE_DEFS.cave_troll.minDepth) eligible.push("cave_troll");
  if (reachableDepth >= HOSTILE_DEFS.giant_spider.minDepth) eligible.push("giant_spider");
  if (reachableDepth >= HOSTILE_DEFS.fire_imp.minDepth) eligible.push("fire_imp");
  if (reachableDepth >= HOSTILE_DEFS.undead.minDepth) eligible.push("undead");
  if (reachableDepth >= HOSTILE_DEFS.automaton.minDepth) eligible.push("automaton");
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
      const equipment = sim.equipment.get(target);
      const equipped = equipment?.weapon === true;
      const weaponQuality = equipment?.weaponQuality ?? 0;
      const inFury = sim.fury.has(target);
      const ambidextrous = dwarf ? effectsFor(dwarf.traitIds).ambidextrous : false;
      const damage =
        DWARF_BASE_DAMAGE +
        Math.floor((military - 1) / 2) +
        (isSoldier ? 5 : 0) +
        (equipped ? 8 : 0) +
        (equipped ? weaponQuality * 2 : 0) + // Fine +2, Masterwork +8 (§6.3).
        (equipped && ambidextrous ? 4 : 0) + // Two-weapon flourish (GDD §6.5).
        (inFury ? 30 : 0); // The Fury: huge bonus, hostiles fall fast.
      hHealth.hp -= damage;
      // Every successful retaliation hit earns military XP — combat
      // experience is the only way the skill grows. Soldiers practising
      // against rats and spiders eventually reach Skilled / Expert and
      // their squad bonus actually matters.
      awardSkillXp(sim, target, "military", 1);
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
        // Hides drop on the corpse tile for the larger creatures —
        // spiders, goblins, trolls (cave rats and incorporeal void
        // entities leave nothing). The tanner picks them up like any
        // other haulable item once a Tannery exists.
        if (def.dropsHide) {
          const hp = sim.position.get(h);
          if (hp) sim.spawnItem({ kind: "hide", x: hp.x, y: hp.y });
        }
        sim.ecs.destroy(h, [sim.position, sim.hostile, sim.health]);
      }
    }
  }
}
