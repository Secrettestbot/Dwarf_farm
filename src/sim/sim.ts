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
import { HOSTILE_DEFS } from "./hostiles/types";
import { ALARM_DURATION_TICKS, ALARM_COOLDOWN_TICKS } from "./emergency";
import { recipeFor } from "./planner/recipes";
import { effectsFor } from "./dwarves/traitEffects";

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
  });
  yearRolloverSystem(sim);
  emergencySystem(sim);
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
  visibilitySystem(sim);
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
  sim.ecs.destroy(e, [sim.position, sim.dwarf, sim.pathing, sim.job, sim.needs, sim.health, sim.carrying]);
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
    if (proposal.kind === "mine") {
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
    }
  }
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
  // Reserve the input on the first tick so a sibling crafter can't drain
  // the stockpile mid-craft.
  if (job.progress === 0) {
    if (sim.stockpile[recipe.inputKind] < recipe.inputQty) {
      sim.job.remove(e);
      sim.pathing.remove(e);
      return;
    }
    sim.stockpile[recipe.inputKind] -= recipe.inputQty;
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
  if (carrying.kind === "ore") sim.stockpile.ore++;
  else if (carrying.kind === "stone") sim.stockpile.stone++;
  else if (carrying.kind === "dirt") sim.stockpile.dirt++;
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

  // Pick a reachable walkable tile deep enough for cave_rat. We sample by
  // scanning the planner's reachable mask deterministically.
  const reachable = sim.planner.exposeReachable(sim);
  if (!reachable) return;
  const grid = sim.grid;
  const w = grid.width;
  const def = HOSTILE_DEFS["cave_rat"];
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
  sim.spawnHostile({ kind: "cave_rat", x: pick.x, y: pick.y });
  sim.events.add(
    sim.tick,
    "crisis",
    narrateHostileSpawn(sim.aiRng, def.spawnArticle, pick.y, sim.spawn.y),
  );
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
      // = base damage). Mining skill doesn't help in a fight.
      const dwarf = sim.dwarf.get(target);
      const military = dwarf?.skills.military ?? 1;
      const damage = DWARF_BASE_DAMAGE + Math.floor((military - 1) / 2);
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
