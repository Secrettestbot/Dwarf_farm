// Social fabric systems — extracted verbatim from sim.ts as part of
// the systems/ decomposition: special traits (Stone-Speaker,
// Ancestor's Voice, Obsessive), The Fury wind-down, tantrums, the
// Mayor/mandate/King civic arc, arguments + grudges + brawls +
// reconciliation, festivals, and the passive trait auras.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { TICKS_PER_DAY, TICKS_PER_YEAR, TICKS_PER_SEASON } from "../time";
import { TileType } from "../world/tiles";
import { effectsFor } from "../dwarves/traitEffects";
import { skillTierLabel } from "../dwarves/skills";
import { fireMilestone, killDwarf } from "./shared";

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

export function specialTraitSystem(sim: SimWorld): void {
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
export function furyEndSystem(sim: SimWorld): void {
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

// ---- Tantrums (GDD §6.4 broken state) --------------------------------
//
// A dwarf whose morale stays at the bottom of the gauge eventually
// breaks: they stop taking productive work, wander aimlessly, and
// grieve openly. Sleep, eat, drink, and shelter override (survival
// can't be skipped) but mining, hauling, crafting, etc., are gated
// out by the chooseTask check on sim.tantrum. The breakdown lasts
// at least TANTRUM_MIN_DURATION; recovery requires morale climbing
// back above TANTRUM_RECOVERY_MORALE.

/** Below this morale value, the daily roll has a chance of starting
 * a tantrum. */
const TANTRUM_TRIGGER_MORALE = 8;
/** Daily probability per qualifying dwarf. Tuned so a colony in
 * sustained crisis sees frequent breakdowns; one bad day rarely
 * triggers. */
const TANTRUM_DAILY_CHANCE = 0.25;
/** Minimum tantrum duration in ticks. Even if morale spikes, the
 * dwarf needs this long to settle. */
const TANTRUM_MIN_DURATION = TICKS_PER_DAY;
/** Maximum tantrum duration. After this they snap out regardless. */
const TANTRUM_MAX_DURATION = TICKS_PER_DAY * 4;
/** Once the dwarf's morale is back above this, they recover (after
 * the minimum duration has elapsed). */
const TANTRUM_RECOVERY_MORALE = 40;
/** Ticks between potential smash attempts. */
const TANTRUM_SMASH_INTERVAL = 120; // every two in-game hours

/** Find a furniture tile adjacent to a tantruming dwarf and smash
 * it back to CorridorFloor. Beds / tables / bins are fair game;
 * Memorial / Headstone / Grave / FarmTile are not — even broken
 * dwarves don't deface graves or trample the crops. Chronicle
 * records each smash. */
function smashAdjacentFurniture(sim: SimWorld, dw: import("../ecs/components").Dwarf, pos: { x: number; y: number }): void {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const x = pos.x + dx;
    const y = pos.y + dy;
    const t = sim.grid.getTile(x, y);
    let label = "";
    if (t === TileType.Bed) label = "bed";
    else if (t === TileType.Table) label = "table";
    else if (t === TileType.Bin) label = "bin";
    else continue;
    sim.grid.setTile(x, y, TileType.CorridorFloor);
    sim.regions.invalidate();
    sim.events.add(
      sim.tick,
      "crisis",
      `${dw.name} smashes a ${label} in their grief. Splinters fly.`,
    );
    return;
  }
}

export function tantrumSystem(sim: SimWorld): void {
  // Recovery / expiration loop — runs every tick.
  const onTantrum = sim.tantrum.entities.slice();
  for (const id of onTantrum) {
    const t = sim.tantrum.get(id);
    if (!t) continue;
    const minMet = sim.tick - t.startedAtTick >= TANTRUM_MIN_DURATION;
    const maxMet = sim.tick >= t.endsAtTick;
    const needs = sim.needs.get(id);
    const recovered = minMet && needs && needs.morale >= TANTRUM_RECOVERY_MORALE;
    if (maxMet || recovered) {
      const dw = sim.dwarf.get(id);
      if (dw) {
        sim.events.add(
          sim.tick,
          "social",
          `${dw.name} comes back to themselves. The breakdown has passed.`,
        );
      }
      sim.tantrum.remove(id);
      continue;
    }
    // Tantrum smashing: every TANTRUM_SMASH_INTERVAL ticks the
    // dwarf takes a swing at adjacent furniture — a Bed, Table, or
    // Bin reverts to CorridorFloor, the chronicle records the
    // damage. Hospital cots and headstones are untouchable (the
    // dwarf has some grief left in them).
    if ((sim.tick - t.startedAtTick) % TANTRUM_SMASH_INTERVAL === 0) {
      const pos = sim.position.get(id);
      const dw = sim.dwarf.get(id);
      if (pos && dw) {
        smashAdjacentFurniture(sim, dw, pos);
      }
    }
  }
  // Trigger roll — once per in-game day.
  if (sim.tick === 0 || sim.tick % TICKS_PER_DAY !== 0) return;
  const dwarves = sim.dwarf.entities;
  for (let i = 0; i < dwarves.length; i++) {
    const id = dwarves[i];
    if (sim.tantrum.has(id)) continue;
    const needs = sim.needs.get(id);
    if (!needs) continue;
    if (needs.morale > TANTRUM_TRIGGER_MORALE) continue;
    if (sim.aiRng.nextFloat() >= TANTRUM_DAILY_CHANCE) continue;
    sim.tantrum.set(id, {
      startedAtTick: sim.tick,
      endsAtTick: sim.tick + TANTRUM_MIN_DURATION + sim.aiRng.nextRange(0, TANTRUM_MAX_DURATION - TANTRUM_MIN_DURATION + 1),
    });
    const dw = sim.dwarf.get(id);
    if (dw) {
      sim.events.add(
        sim.tick,
        "crisis",
        `${dw.name} has broken. They wander the halls muttering, refusing all work.`,
      );
    }
  }
}


// ---- Mayor + festival -------------------------------------------------
//
// Once per in-game year the colony elects (informally — Dwarven
// tradition is rough about it) a Mayor: the dwarf with the highest
// leadership skill, provided they meet the minimum threshold. Their
// presence in any tile gives the fortress a small morale aura via
// the existing passive-trait sweep, just like a Natural Leader. The
// chronicle records each new term:
//
//   "The colony recognises Borin as its new Mayor. The leadership
//    skill: Skilled."
//
// Festivals fire once per in-game season when the colony's median
// morale is high — a quiet affirmation of good times. Bumps every
// dwarf's morale by FESTIVAL_MORALE_BUMP and writes a celebratory
// line to the chronicle.

const MAYOR_MIN_SKILL = 5; // Adequate Leadership
const FESTIVAL_INTERVAL = TICKS_PER_SEASON;
const FESTIVAL_MIN_MEDIAN_MORALE = 75;
const FESTIVAL_MORALE_BUMP = 5;
const FESTIVAL_LINES: ReadonlyArray<string> = [
  "The colony holds a small festival in the dining hall. Songs are sung; old grievances are laughed off.",
  "The colony toasts a quiet good year. Even the gloomiest dwarves crack a smile.",
  "A festival is held — no particular reason, only that the mood is good and the larder is full.",
];

export function mayorSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  let best: { id: EntityId; skill: number } | null = null;
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const skill = dw.skills.leadership ?? 1;
    if (skill < MAYOR_MIN_SKILL) continue;
    if (sim.ageOf(id) < 18) continue;
    if (!best || skill > best.skill || (skill === best.skill && id < best.id)) {
      best = { id, skill };
    }
  }
  if (!best) {
    sim.mayorName = "";
    sim.mayorId = -1;
    return;
  }
  const dw = sim.dwarf.get(best.id);
  if (!dw) return;
  if (best.id === sim.mayorId) return; // re-elected, no event
  sim.mayorId = best.id;
  sim.mayorName = dw.name;
  sim.events.add(
    sim.tick,
    "social",
    `The colony recognises ${dw.name} as its new Mayor. Their leadership: ${skillTierLabel(best.skill)}.`,
  );
}

/** Resources the mayor can mandate the colony produce. All are
 * counter-backed (no item-entity routing) so progress is a simple
 * stockpile delta from the baseline at mandate issue time to the
 * counter at the deadline. */
const MANDATE_RESOURCES: ReadonlyArray<string> = [
  "cut_gems", "tools", "blocks", "bars", "planks",
  "cloth", "leather", "pots",
];

/** Per-season mandate. Issued at season boundaries when a mayor's
 * in office and there's no active mandate, evaluated when the
 * deadline tick passes. Production-based: target = baseline + N,
 * where N scales with population so a 30-dwarf colony has bigger
 * mandates than a 12-dwarf one. */
export function mandateSystem(sim: SimWorld): void {
  // Evaluate first — if a mandate is active and its deadline lands
  // on this tick, score it and clear. Doing this before issuing a
  // new one means a deadline-day tick can hand the colony its next
  // target in the same hour.
  if (sim.mandateResource && sim.mandateEndTick > 0 && sim.tick >= sim.mandateEndTick) {
    const sp = sim.stockpile as unknown as Record<string, number>;
    const produced = (sp[sim.mandateResource] ?? 0) - sim.mandateBaseline;
    const need = sim.mandateTarget - sim.mandateBaseline;
    const satisfied = produced >= need;
    if (satisfied) {
      sim.mandatesSatisfied++;
      // Small fortress-wide morale bump for compliance.
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) n.morale = Math.min(100, n.morale + 4);
      }
      sim.events.add(
        sim.tick,
        "milestone",
        `${sim.mayorName || "The mayor"}'s mandate is satisfied — ${produced} ${sim.mandateResource} produced this season. The colony's mood lifts.`,
      );
    } else {
      sim.mandatesFailed++;
      // Small morale hit for missed mandate. Indirect-control
      // shape: ignoring mandates costs a little colony mood, but
      // the player can absolutely choose to.
      for (const id of sim.dwarf.entities) {
        const n = sim.needs.get(id);
        if (n) n.morale = Math.max(0, n.morale - 3);
      }
      sim.events.add(
        sim.tick,
        "social",
        `${sim.mayorName || "The mayor"}'s mandate goes unmet — only ${Math.max(0, produced)} of ${need} ${sim.mandateResource} produced. The colony grumbles.`,
      );
    }
    sim.mandateResource = "";
    sim.mandateTarget = 0;
    sim.mandateBaseline = 0;
    sim.mandateEndTick = -1;
  }

  // Issue: at season boundary, when a mayor's in office and no
  // mandate is currently active. Skips if pop is too small to
  // justify a mandate or the mayor's been wiped out.
  if (sim.tick === 0) return;
  if (sim.tick % TICKS_PER_SEASON !== 0) return;
  if (!sim.mayorName) return;
  if (sim.mandateResource) return; // still mid-cycle
  if (sim.dwarf.size() < 12) return;
  const resource = MANDATE_RESOURCES[sim.aiRng.nextRange(0, MANDATE_RESOURCES.length)];
  const sp = sim.stockpile as unknown as Record<string, number>;
  const baseline = sp[resource] ?? 0;
  // Production target: ~ pop / 4, floor 3. A 20-dwarf colony's
  // mandate asks for 5 units; a 40-dwarf colony asks for 10.
  const ask = Math.max(3, Math.floor(sim.dwarf.size() / 4));
  sim.mandateResource = resource;
  sim.mandateBaseline = baseline;
  sim.mandateTarget = baseline + ask;
  sim.mandateEndTick = sim.tick + TICKS_PER_SEASON;
  sim.events.add(
    sim.tick,
    "social",
    `${sim.mayorName} issues a mandate: produce ${ask} more ${resource} before the season turns.`,
  );
}
/** Population at which the colony stops being a Mayor's town and
 * starts wanting a King. Tuned so a small fortress doesn't crown
 * itself the moment a throne room finishes. */
const KING_POPULATION_THRESHOLD = 50;

/** Skill threshold a dwarf has to clear in BOTH leadership and
 * military to be eligible for kingship. The colony's leader has
 * to be both respected and dangerous. */
const KING_MIN_SKILL = 9; // Skilled

export function kingSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TICKS_PER_YEAR !== 0) return;
  // Throne room must exist and be complete.
  let hasThroneRoom = false;
  for (const b of sim.planner.blueprints) {
    if (b.kind === "throne_room" && b.status === "complete") {
      hasThroneRoom = true;
      break;
    }
  }
  if (!hasThroneRoom) {
    if (sim.kingName) {
      // Throne room destroyed somehow? Strip royalty.
      sim.kingName = "";
      sim.kingId = -1;
    }
    return;
  }
  if (sim.dwarf.size() < KING_POPULATION_THRESHOLD) return;
  // Find the most-respected combatant: highest combined leadership +
  // military skill among adults meeting both thresholds.
  let best: { id: EntityId; score: number } | null = null;
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    if (sim.ageOf(id) < 25) continue;
    const lead = dw.skills.leadership ?? 1;
    const mil = dw.skills.military ?? 1;
    if (lead < KING_MIN_SKILL || mil < KING_MIN_SKILL) continue;
    const score = lead + mil;
    if (!best || score > best.score || (score === best.score && id < best.id)) {
      best = { id, score };
    }
  }
  if (!best) {
    // No qualifying dwarf yet — the throne sits empty until one
    // emerges. The chronicle has noted the throne room before;
    // this is just a quiet pass.
    return;
  }
  const dw = sim.dwarf.get(best.id);
  if (!dw) return;
  if (best.id === sim.kingId) return; // re-coronation, no event
  const previous = sim.kingName;
  sim.kingId = best.id;
  sim.kingName = dw.name;
  if (previous) {
    sim.events.add(
      sim.tick,
      "milestone",
      `${dw.name} is crowned the new King. ${previous} steps down with their honour intact.`,
    );
  } else {
    sim.events.add(
      sim.tick,
      "milestone",
      `${dw.name} is crowned the colony's first King. The throne room is no longer empty.`,
    );
    fireMilestone(
      sim,
      "the_first_king",
      `The First King. ${dw.name} sits the throne, by virtue of leadership and arms both.`,
    );
  }
}


// ---- Arguments + brawls ----------------------------------------------
//
// Once per in-game day the colony's social tensions get a single
// roll: every adjacent pair with at least one Antagonistic dwarf
// has a chance of arguing (small morale hit on both, chronicle
// line); a tantruming dwarf has a higher chance of throwing a
// punch (small HP hit on the neighbour, larger morale hit on both).
// The brawl roll is the only way the colony's internal social
// stress translates to physical injury.

const ARGUMENT_DAILY_CHANCE = 0.4;
const ARGUMENT_MORALE_HIT = 5;
const BRAWL_TANTRUM_CHANCE = 0.5;
const BRAWL_DAMAGE = 4;
const BRAWL_MORALE_HIT = 10;
/** Grudge mechanics — every argument adds 1 to the pair's grudge,
 * every brawl adds 2. The recurring chance of arguing scales with
 * grudge so a feuding pair argues more often, and once a grudge
 * crosses GRUDGE_BRAWL_THRESHOLD an argument may escalate into a
 * brawl even without a tantrum. Grudges decay 1 point per
 * GRUDGE_DECAY_TICKS of quiet between this pair. */
const GRUDGE_PER_ARGUMENT = 1;
const GRUDGE_PER_BRAWL = 2;
const GRUDGE_ARGUMENT_SCALE = 0.15; // each grudge point adds 15% to the daily argument chance
const GRUDGE_BRAWL_THRESHOLD = 4;
const GRUDGE_BRAWL_BASE_CHANCE = 0.2;
const GRUDGE_DECAY_TICKS = 30 * TICKS_PER_DAY; // an in-game month of quiet shaves a point

/** Canonical key for a grudge between two dwarves. Smaller id first
 * so (a,b) and (b,a) resolve to the same entry. */
function grudgeKey(a: EntityId, b: EntityId): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Read the current grudge count between two dwarves, applying any
 * pending decay since the last incident. Decay is computed lazily on
 * read so a thousand peaceful pairs don't burn ticks every day. */
export function grudgeCount(sim: SimWorld, a: EntityId, b: EntityId): number {
  const entry = sim.grudges.get(grudgeKey(a, b));
  if (!entry) return 0;
  const elapsed = sim.tick - entry.lastIncidentTick;
  const decayed = Math.floor(elapsed / GRUDGE_DECAY_TICKS);
  return Math.max(0, entry.count - decayed);
}

/** Bump a pair's grudge by `delta` and record this tick as the most
 * recent incident. Lazy-decays first so a stale entry doesn't accrue
 * indefinitely. */
function bumpGrudge(sim: SimWorld, a: EntityId, b: EntityId, delta: number): void {
  const key = grudgeKey(a, b);
  const cur = grudgeCount(sim, a, b);
  sim.grudges.set(key, { count: cur + delta, lastIncidentTick: sim.tick });
}

export function argumentSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % TICKS_PER_DAY !== 0) return;
  const dwarves = sim.dwarf.entities;
  if (dwarves.length < 2) return;
  // Pre-build a position lookup so we can find adjacent pairs in
  // O(N) instead of O(N²). Key: packed (y << 16 | x).
  const tileToDwarf = new Map<number, EntityId>();
  for (let i = 0; i < dwarves.length; i++) {
    const id = dwarves[i];
    const p = sim.position.get(id);
    if (!p) continue;
    tileToDwarf.set((p.y << 16) | p.x, id);
  }
  // Iterate dwarves; for each, check the four cardinal neighbours
  // for another dwarf. Sort the pair by id so we don't fire twice.
  const seenPairs = new Set<string>();
  for (let i = 0; i < dwarves.length; i++) {
    const id = dwarves[i];
    const p = sim.position.get(id);
    const dw = sim.dwarf.get(id);
    if (!p || !dw) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const other = tileToDwarf.get(((p.y + dy) << 16) | (p.x + dx));
      if (other === undefined || other === id) continue;
      const pairKey = id < other ? `${id}:${other}` : `${other}:${id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const otherDw = sim.dwarf.get(other);
      if (!otherDw) continue;
      const aAntag = dw.traitIds.includes("antagonistic");
      const bAntag = otherDw.traitIds.includes("antagonistic");
      const inTantrumA = sim.tantrum.has(id);
      const inTantrumB = sim.tantrum.has(other);
      const grudge = grudgeCount(sim, id, other);
      // Tantrum brawl: one of the pair is broken and lashes out.
      if (inTantrumA || inTantrumB) {
        if (sim.aiRng.nextFloat() < BRAWL_TANTRUM_CHANCE) {
          const aggressor = inTantrumA ? id : other;
          const victim = inTantrumA ? other : id;
          resolveBrawl(sim, aggressor, victim, "fury");
        }
        continue;
      }
      // Grudge brawl: a long-feuding pair throws hands without a
      // tantrum once the ledger crosses the threshold.
      if (grudge >= GRUDGE_BRAWL_THRESHOLD) {
        const brawlChance = GRUDGE_BRAWL_BASE_CHANCE + (grudge - GRUDGE_BRAWL_THRESHOLD) * 0.05;
        if (sim.aiRng.nextFloat() < brawlChance) {
          // The dwarf with lower morale throws the first punch —
          // matches the lived experience of a brawl breaking out.
          const aN = sim.needs.get(id);
          const bN = sim.needs.get(other);
          const aMorale = aN?.morale ?? 50;
          const bMorale = bN?.morale ?? 50;
          const aggressor = aMorale <= bMorale ? id : other;
          const victim = aggressor === id ? other : id;
          resolveBrawl(sim, aggressor, victim, "grudge");
          continue;
        }
      }
      // Argument: needs at least an Antagonistic dwarf or an existing
      // grudge to be eligible. Grudge inflates the chance so a
      // feuding pair argues weekly, then daily, then escalates.
      const eligibleForArgument = aAntag || bAntag || grudge > 0;
      if (eligibleForArgument) {
        const chance = ARGUMENT_DAILY_CHANCE * (1 + GRUDGE_ARGUMENT_SCALE * grudge);
        if (sim.aiRng.nextFloat() < chance) {
          const aN = sim.needs.get(id);
          const bN = sim.needs.get(other);
          if (aN) aN.morale = Math.max(0, aN.morale - ARGUMENT_MORALE_HIT);
          if (bN) bN.morale = Math.max(0, bN.morale - ARGUMENT_MORALE_HIT);
          bumpGrudge(sim, id, other, GRUDGE_PER_ARGUMENT);
          // Wording shifts as grievances pile up — the colony's
          // chronicle reads differently for a one-off snip vs. a
          // years-deep feud.
          const text = grudge >= 6
            ? `${dw.name} and ${otherDw.name} clash again. The whole colony has stopped pretending the feud isn't there.`
            : grudge >= 2
              ? `${dw.name} and ${otherDw.name} argue once more. Old grievances surface.`
              : `${dw.name} and ${otherDw.name} argue heatedly.`;
          sim.events.add(sim.tick, "social", text);
        }
      }
    }
  }
}

/** Apply a brawl outcome between two dwarves: HP drain on the
 * victim, morale hit on both, chronicle line, and grudge bump.
 * Triggers killDwarf if the victim's HP reaches zero. The cause
 * string lets the chronicle distinguish a tantrum strike from a
 * long-grudge fight. */
function resolveBrawl(sim: SimWorld, aggressor: EntityId, victim: EntityId, kind: "fury" | "grudge"): void {
  const aDw = sim.dwarf.get(aggressor);
  const vDw = sim.dwarf.get(victim);
  if (!aDw || !vDw) return;
  const vHp = sim.health.get(victim);
  if (vHp) vHp.hp = Math.max(0, vHp.hp - BRAWL_DAMAGE);
  const aN = sim.needs.get(aggressor);
  const vN = sim.needs.get(victim);
  if (aN) aN.morale = Math.max(0, aN.morale - BRAWL_MORALE_HIT);
  if (vN) vN.morale = Math.max(0, vN.morale - BRAWL_MORALE_HIT);
  bumpGrudge(sim, aggressor, victim, GRUDGE_PER_BRAWL);
  const line = kind === "fury"
    ? `${aDw.name} strikes ${vDw.name} in their fury. The colony watches in silence.`
    : `${aDw.name} swings on ${vDw.name}. The grudge between them spills into blood.`;
  const aPos = sim.position.get(aggressor);
  sim.events.add(sim.tick, "crisis", line, aPos ? { x: aPos.x, y: aPos.y } : undefined);
  if (vHp && vHp.hp <= 0) {
    killDwarf(sim, victim, `struck dead by ${aDw.name}`);
  }
}

/** Daily chance for a standing feud to END (GDD §6.4 social fabric).
 * Reconciliation needs somewhere for it to happen — a tavern round or
 * the Mayor sitting the pair down — and both parties in a good enough
 * mood to accept it. Deep feuds resist: the chance shrinks with the
 * grudge count. */
const RECONCILE_TAVERN_CHANCE = 0.08;
const RECONCILE_MAYOR_CHANCE = 0.07;
const RECONCILE_MIN_MORALE = 60;
const RECONCILE_MORALE_LIFT = 5;

export function reconciliationSystem(sim: SimWorld): void {
  if (sim.tick === 0 || sim.tick % TICKS_PER_DAY !== 0) return;
  if (sim.grudges.size === 0) return;
  const hasTavern = sim.planner.blueprints.some((b) => b.kind === "tavern" && b.status === "complete");
  const mayorAlive = sim.mayorId !== -1 && sim.dwarf.has(sim.mayorId);
  if (!hasTavern && !mayorAlive) return;
  for (const [key, entry] of Array.from(sim.grudges.entries())) {
    const [a, b] = key.split(":").map(Number);
    const dwA = sim.dwarf.get(a);
    const dwB = sim.dwarf.get(b);
    if (!dwA || !dwB) {
      sim.grudges.delete(key);
      continue;
    }
    // Lazily-decayed entries that reached zero just get pruned.
    if (grudgeCount(sim, a, b) <= 0) {
      sim.grudges.delete(key);
      continue;
    }
    const na = sim.needs.get(a);
    const nb = sim.needs.get(b);
    if (!na || !nb) continue;
    if (na.morale < RECONCILE_MIN_MORALE || nb.morale < RECONCILE_MIN_MORALE) continue;
    let chance = (hasTavern ? RECONCILE_TAVERN_CHANCE : 0) + (mayorAlive ? RECONCILE_MAYOR_CHANCE : 0);
    chance /= 1 + entry.count * 0.15;
    if (sim.aiRng.nextFloat() >= chance) continue;
    sim.grudges.delete(key);
    na.morale = Math.min(100, na.morale + RECONCILE_MORALE_LIFT);
    nb.morale = Math.min(100, nb.morale + RECONCILE_MORALE_LIFT);
    const line = hasTavern
      ? `${dwA.name} and ${dwB.name} share a round at the tavern. Whatever it was, it's done.`
      : `${sim.mayorName || "The Mayor"} sits ${dwA.name} and ${dwB.name} down. The feud ends with a handshake nobody quite believes, but it holds.`;
    sim.events.add(sim.tick, "social", line);
  }
}

export function festivalSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % FESTIVAL_INTERVAL !== 0) return;
  if (sim.emergency.mode !== "none") return;
  const ents = sim.dwarf.entities;
  if (ents.length < 4) return;
  // Median morale — a festival happens when the colony's mood is
  // broadly good, not when one cheerful elder pulls the average up.
  const morales: number[] = [];
  for (let i = 0; i < ents.length; i++) {
    const n = sim.needs.get(ents[i]);
    if (n) morales.push(n.morale);
  }
  if (morales.length === 0) return;
  morales.sort((a, b) => a - b);
  const median = morales[Math.floor(morales.length / 2)];
  if (median < FESTIVAL_MIN_MEDIAN_MORALE) return;
  // Bump everyone's morale a touch.
  for (let i = 0; i < ents.length; i++) {
    const n = sim.needs.get(ents[i]);
    if (!n) continue;
    n.morale = Math.min(100, n.morale + FESTIVAL_MORALE_BUMP);
  }
  const line = FESTIVAL_LINES[sim.aiRng.nextRange(0, FESTIVAL_LINES.length)];
  sim.events.add(sim.tick, "social", line);
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

export function passiveTraitSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % PASSIVE_TRAIT_INTERVAL !== 0) return;
  const ents = sim.dwarf.entities;
  // Aura pass — Natural Leader (+1) and Antagonistic (-1) both run
  // through the same shape: walk every dwarf within LEADER_AURA_RADIUS
  // and apply auraMorale. The Mayor adds another +1 fortress-wide
  // (no radius) — the colony's general sense of "being led".
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
  // Mayor aura: a small fortress-wide morale bump. The mayor name
  // is set yearly by mayorSystem; we re-resolve their entity here.
  if (sim.mayorName) {
    const mayorAlive = sim.mayorId !== -1 && sim.dwarf.has(sim.mayorId);
    if (mayorAlive) {
      for (const other of ents) {
        const n = sim.needs.get(other);
        if (!n) continue;
        n.morale = Math.min(100, n.morale + 1);
      }
    } else {
      // Mayor passed away. Strip the title with a chronicle line; the
      // next yearly tick of mayorSystem picks a successor.
      sim.events.add(
        sim.tick,
        "social",
        `${sim.mayorName} is dead. The Mayor's seat is empty until the next year's recognition.`,
      );
      sim.mayorName = "";
      sim.mayorId = -1;
    }
  }
  // King aura: a stronger fortress-wide bump than the mayor. The
  // King's presence is the colony's pride.
  if (sim.kingName) {
    const kingAlive = sim.kingId !== -1 && sim.dwarf.has(sim.kingId);
    if (kingAlive) {
      for (const other of ents) {
        const n = sim.needs.get(other);
        if (!n) continue;
        n.morale = Math.min(100, n.morale + 2);
      }
    } else if (sim.kingName) {
      // King died or was lost. Strip the title; the next yearly
      // tick of kingSystem will pick a successor.
      sim.events.add(
        sim.tick,
        "crisis",
        `The King is dead. The throne sits empty, awaiting a worthy successor.`,
      );
      sim.kingName = "";
      sim.kingId = -1;
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

