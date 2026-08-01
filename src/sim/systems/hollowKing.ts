// The Hollow King arc (GDD §9.4) — awakening, nightmares, void-shade
// sieges, and the King's manifestation. Extracted verbatim from
// sim.ts as part of the systems/ decomposition.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { TICKS_PER_DAY } from "../time";
import { fireMilestone } from "./shared";

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
export const HOLLOW_KING_VICTORY_THRESHOLD = 20;

export function hollowKingSystem(sim: SimWorld): void {
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
export function hollowKingManifestSystem(sim: SimWorld): void {
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

