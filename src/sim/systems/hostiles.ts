// Hostile-side systems — extracted verbatim from sim.ts as part of
// the systems/ decomposition: the active-zone gate (with its coarse
// per-tick cache), hostile spawning, sieges (spawn + withdrawal),
// pursuit movement (budgeted goblin A*), and melee combat.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { unpackCell } from "../pathing/astar";
import { TICKS_PER_DAY, TICKS_PER_YEAR } from "../time";
import { TileType } from "../world/tiles";
import { effectsFor } from "../dwarves/traitEffects";
import { HOSTILE_DEFS, HostileKind } from "../hostiles/types";
import { narrateHostileSpawn, narrateHostileSlain } from "../events/narrator";
import { awardSkillXp, fireMilestone, killDwarf } from "./shared";
import { HOLLOW_KING_VICTORY_THRESHOLD } from "./hollowKing";

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
const ACTIVE_COARSE = 64;
const ACTIVE_COARSE_REACH = Math.ceil(ACTIVE_RADIUS / ACTIVE_COARSE);
const activeZoneCache = new WeakMap<SimWorld, { tick: number; coarse: Set<number> }>();

function isInActiveZone(sim: SimWorld, x: number, y: number): boolean {
  // Coarse fast-reject: mark every 64-tile cell within reach of a
  // dwarf once per tick. A query cell not in the set is provably out
  // of range (|d| <= 100 implies coarse delta <= 2), so far hostiles
  // — the common case — skip the per-dwarf scan entirely. Cells in
  // the set fall through to the exact check, keeping the semantics
  // identical to the uncached version.
  let cache = activeZoneCache.get(sim);
  if (!cache || cache.tick !== sim.tick) {
    const coarse = new Set<number>();
    sim.forEachDwarf((_id, p) => {
      const cx = (p.x / ACTIVE_COARSE) | 0;
      const cy = (p.y / ACTIVE_COARSE) | 0;
      for (let dy = -ACTIVE_COARSE_REACH; dy <= ACTIVE_COARSE_REACH; dy++) {
        for (let dx = -ACTIVE_COARSE_REACH; dx <= ACTIVE_COARSE_REACH; dx++) {
          coarse.add((cy + dy) * 4096 + (cx + dx));
        }
      }
    });
    cache = { tick: sim.tick, coarse };
    activeZoneCache.set(sim, cache);
  }
  if (!cache.coarse.has(((y / ACTIVE_COARSE) | 0) * 4096 + ((x / ACTIVE_COARSE) | 0))) {
    return false;
  }
  let active = false;
  sim.forEachDwarf((_id, p) => {
    if (active) return;
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy <= ACTIVE_RADIUS_SQ) active = true;
  });
  return active;
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

// ---- Sieges ----------------------------------------------------------
//
// Once per in-game year a goblin warband marches on the colony's
// entrance. Unlike the steady drip of HOSTILE_SPAWN_INTERVAL_TICKS
// creatures, sieges are a coordinated 8-20 enemy event: they arrive
// at the surface near the entrance shaft, the player gets a 5-day
// warning to muster the draft / forge / armoury chain, and the
// chronicle treats them as a named event (Siege of Year 5).
//
// Indirect control: the player doesn't pick when sieges happen, but
// the pre-announcement gives them time to bump Military / Crafting
// sliders to ready weapons and pull soldiers from civilian work.

const SIEGE_INTERVAL_TICKS = TICKS_PER_YEAR; // once per in-game year
const SIEGE_PREANNOUNCE_LEAD = TICKS_PER_DAY * 5;
const SIEGE_MIN_POPULATION = 10; // sieges start when the colony is worth raiding
/** A warband that hasn't broken the fortress after this long packs up
 * and leaves. Without it, a walled-off colony faced an eternal siege —
 * goblins path well now, but they can't dig, so an unreachable
 * fortress stalled the siege state forever. */
const SIEGE_WITHDRAW_TICKS = TICKS_PER_DAY * 6;

export function siegeSystem(sim: SimWorld): void {
  // Mid-siege check: if the warband is wiped, fire a victory event.
  if (sim.siegeActive) {
    let liveAttackers = 0;
    for (const id of sim.hostile.entities) {
      const h = sim.hostile.get(id);
      if (h && h.siegeMember) liveAttackers++;
    }
    if (liveAttackers === 0) {
      sim.siegeActive = false;
      sim.siegeStartedAtTick = -1;
      sim.siegesSurvived++;
      sim.events.add(
        sim.tick,
        "milestone",
        `The siege is broken. The fortress holds — count it the ${ordinal(sim.siegesSurvived)} the colony has survived.`,
      );
    } else if (
      sim.siegeStartedAtTick >= 0 &&
      sim.tick - sim.siegeStartedAtTick >= SIEGE_WITHDRAW_TICKS
    ) {
      // Withdrawal: the warband gives up. Outlasting a siege counts
      // as surviving it — the fortress held, whether by axe or wall.
      for (const id of sim.hostile.entities.slice()) {
        const h = sim.hostile.get(id);
        if (!h || !h.siegeMember) continue;
        sim.hostileNames.delete(id);
        sim.ecs.destroy(id, [sim.position, sim.hostile, sim.health]);
      }
      sim.siegeActive = false;
      sim.siegeStartedAtTick = -1;
      sim.siegesSurvived++;
      sim.events.add(
        sim.tick,
        "milestone",
        `The warband breaks camp and withdraws — six days at the gate bought them nothing. Count it the ${ordinal(sim.siegesSurvived)} siege the colony has survived.`,
      );
    }
  }

  // Schedule the next siege at year boundaries (after the first
  // year, so a brand-new colony isn't sieged on day one).
  if (
    sim.tick > 0 &&
    sim.tick % SIEGE_INTERVAL_TICKS === 0 &&
    sim.siegeScheduledTick === -1 &&
    !sim.siegeActive
  ) {
    if (sim.dwarf.size() >= SIEGE_MIN_POPULATION) {
      sim.siegeScheduledTick = sim.tick + SIEGE_PREANNOUNCE_LEAD;
      sim.siegeAnnounced = false;
    }
  }

  // Outrider: fire the warning event a full lead-window before the
  // warband arrives so the player has time to react.
  if (sim.siegeScheduledTick > 0 && !sim.siegeAnnounced) {
    sim.events.add(
      sim.tick,
      "crisis",
      `Scouts spot a goblin warband approaching from the slopes. The colony has five days to prepare — call up the militia and stock the depot with weapons.`,
    );
    sim.siegeAnnounced = true;
  }

  // Arrival: spawn the warband at the surface near the entrance.
  if (sim.siegeScheduledTick > 0 && sim.tick >= sim.siegeScheduledTick) {
    spawnSiegeWarband(sim);
    sim.siegeScheduledTick = -1;
    sim.siegeAnnounced = false;
  }
}

/** First-name + epithet pool the warlord rolls a name from. Picked
 * deterministically off aiRng so the same seed produces the same
 * "Siege of Year 5 was led by Drogmar Black-Tongue" entry every
 * replay. Names skew Norse / orcish but stay short — chronicle
 * lines need to read at a glance. */
const WARLORD_FIRST_NAMES: ReadonlyArray<string> = [
  "Drogmar", "Skarn", "Ulgrim", "Vurok", "Ghazak", "Murz", "Krogh",
  "Brakka", "Hashtar", "Yargol", "Nazgrim", "Snaga", "Thrak",
];
const WARLORD_EPITHETS: ReadonlyArray<string> = [
  "Black-Tongue", "the Cleaver", "Iron-Jaw", "Six-Fingers",
  "the Cunning", "Bone-Drinker", "Red-Banner", "the Patient",
  "Sharp-Eye", "Two-Axes", "the Pale", "Stone-Breaker",
];

function rollWarlordName(sim: SimWorld): string {
  const first = WARLORD_FIRST_NAMES[sim.aiRng.nextRange(0, WARLORD_FIRST_NAMES.length)];
  const epithet = WARLORD_EPITHETS[sim.aiRng.nextRange(0, WARLORD_EPITHETS.length)];
  return `${first} ${epithet}`;
}

function spawnSiegeWarband(sim: SimWorld): void {
  // Scale the warband with population. ~4 base + 1 extra per 4
  // dwarves caps a 60-dwarf colony at ~19 goblins. Add a single
  // troll once the colony's substantial. Once the colony's at the
  // siege-min threshold (pop ≥ 15) a named warlord leads the
  // warband — gives the chronicle a real foe to remember.
  const pop = sim.dwarf.size();
  const goblinCount = Math.min(20, 4 + Math.floor(pop / 4));
  const trollCount = pop >= 25 ? 1 : 0;
  const warlordCount = pop >= 15 ? 1 : 0;
  const warlordName = warlordCount > 0 ? rollWarlordName(sim) : "";

  // Spawn site: surface row near spawn.x. We sample a small
  // horizontal range so the warband fans out rather than stacking
  // on one tile.
  const grid = sim.grid;
  const baseX = sim.spawn.x;
  const candidates: Array<{ x: number; y: number }> = [];
  for (let dx = -8; dx <= 8; dx++) {
    const x = baseX + dx;
    if (x < 0 || x >= grid.width) continue;
    const y = sim.surfaceY[x];
    const tile = grid.getTile(x, y);
    if (tile === TileType.Grass || tile === TileType.CorridorFloor) {
      candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) {
    // No surface foothold — fall back to the spawn tile itself.
    candidates.push({ x: baseX, y: sim.spawn.y });
  }

  for (let i = 0; i < goblinCount; i++) {
    const c = candidates[sim.aiRng.nextRange(0, candidates.length)];
    sim.spawnHostile({ kind: "goblin_scout", x: c.x, y: c.y, siegeMember: true });
  }
  for (let i = 0; i < trollCount; i++) {
    const c = candidates[sim.aiRng.nextRange(0, candidates.length)];
    sim.spawnHostile({ kind: "cave_troll", x: c.x, y: c.y, siegeMember: true });
  }
  for (let i = 0; i < warlordCount; i++) {
    const c = candidates[sim.aiRng.nextRange(0, candidates.length)];
    const wid = sim.spawnHostile({ kind: "goblin_warlord", x: c.x, y: c.y, siegeMember: true });
    if (wid !== -1) sim.hostileNames.set(wid, warlordName);
  }

  sim.siegeActive = true;
  sim.siegeStartedAtTick = sim.tick;
  sim.siegeKilledSinceStart = 0;
  sim.siegeWarlordName = warlordName;
  const leaderClause = warlordCount > 0
    ? `, led by ${warlordName}`
    : (trollCount > 0 ? ` with a cave troll at their head` : "");
  sim.events.add(
    sim.tick,
    "crisis",
    `The siege begins. ${goblinCount} goblins${leaderClause} pour onto the surface near the gate. The fortress is on its own now.`,
    { x: candidates[0].x, y: candidates[0].y },
  );
}

function ordinal(n: number): string {
  const last2 = n % 100;
  if (last2 >= 11 && last2 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Periodically a creature finds its way into the colony. We pick a
 * reachable walkable tile that is (a) deep enough for the kind to spawn,
 * (b) safely away from any dwarf so they get to discover it. Cap is
 * proportional to the colony's size so a one-dwarf colony isn't swarmed.
 */
export function hostileSpawnSystem(sim: SimWorld): void {
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

/** Node budget for goblin pursuit pathfinding. Small on purpose: the
 * pursue radius caps useful path length, and an unreachable target
 * fast-fails via the region map before burning the budget. */
const GOBLIN_PATH_BUDGET = 600;

/**
 * Pursuit movement. Goblins (scouts + warlords) run budgeted A* toward
 * their chosen target so walls and concave rooms don't stop them;
 * everything else takes a greedy sign-of-delta step, fenced by
 * walkability — cheap and good enough for cave-rat-scale threats.
 */
export function hostileMovementSystem(sim: SimWorld): void {
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
    // Goblins (scouts + warlord) target intelligently — the mayor
    // first, then unarmed civilians and wounded dwarves, then
    // soldiers last. Other hostiles (rats, spiders, trolls)
    // still go for the nearest body. The softness bonus is
    // converted to a "phantom distance reduction" so a soft
    // target up to ~5 tiles farther can beat a closer hard target.
    const isGoblin = h.kind === "goblin_scout" || h.kind === "goblin_warlord";
    let bestScore = (def.pursueRange + 1) * (def.pursueRange + 1);
    let bestPos: { x: number; y: number } | null = null;
    sim.forEachDwarf((id, p) => {
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > def.pursueRange * def.pursueRange) return;
      let score = d2;
      if (isGoblin) {
        const hp = sim.health.get(id);
        // Mayor's a banner kill — most-preferred target.
        if (id === sim.mayorId) score -= 50;
        // Civilians (not in the militia squad) score better than
        // armoured soldiers — soft underbellies first.
        if (!sim.squad.has(id)) score -= 25;
        // Children — under MIN_WORK_AGE 18 — are easy kills.
        if (sim.ageOf(id) < 18) score -= 35;
        // Already-wounded dwarves finish faster than fresh ones.
        if (hp && hp.hp < hp.maxHp * 0.5) score -= 15;
        // No floor — softness can drive a target's score below
        // zero. The pursueRange gate above keeps the goblin from
        // chasing a maximally-soft target across the map, and
        // letting the score go negative is what lets two equal-
        // distance targets be ordered by their softness sum.
      }
      if (score < bestScore) {
        bestScore = score;
        bestPos = { x: p.x, y: p.y };
      }
    });
    if (!bestPos) continue;
    h.lastMoveTick = sim.tick;
    const target: { x: number; y: number } = bestPos;
    // Goblins path properly (budgeted A*) so a concave wall doesn't
    // pin the warband against the fortress forever — that made sieges
    // trivial to wall off. The budget keeps a big warband cheap: each
    // goblin paths at most once per moveCooldown, and the region map
    // fast-fails unreachable targets. Everything else (rats, bats,
    // trolls) keeps the greedy sign-step — pest-tier creatures
    // bumbling into walls is fine flavor.
    if (isGoblin) {
      const path = sim.astar.findPath(sim.grid, pos.x, pos.y, target.x, target.y, GOBLIN_PATH_BUDGET);
      if (path && path.length >= 2) {
        const next = unpackCell(path[1]);
        pos.x = next.x;
        pos.y = next.y;
        continue;
      }
      // No route within budget — fall through to the greedy step so
      // the goblin still paces at the wall instead of freezing.
    }
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
export function combatSystem(sim: SimWorld): void {
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
        // Named foes get a bespoke chronicle line so the warlord's
        // fall is memorable instead of "a goblin warlord falls."
        const foeName = sim.hostileNames.get(h);
        if (foeName) {
          sim.events.add(
            sim.tick,
            "milestone",
            `${dwarfName} fells ${foeName}, the goblin warlord. The siege loses its banner.`,
          );
          sim.hostileNames.delete(h);
        } else {
          sim.events.add(
            sim.tick,
            "crisis",
            narrateHostileSlain(sim.aiRng, dwarfName, def.name),
          );
        }
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
