// Slider → labour weighting (GDD §4.1).
//
// Sliders are continuous, not on/off switches. The neutral value (0.5)
// leaves the autonomous priority cascade in chooseTask untouched. Moving
// a work slider away from neutral reshapes the colony's labour split:
//
// - Below neutral, the category is capped at a share of the working
//   population (slider × 2). At 0.25 at most half the workers do it;
//   at ≤ 0.05 nobody does.
// - Above neutral, a deterministic share of workers ((slider − 0.5) × 2)
//   try that category *before* the normal cascade — at 1.0 every worker
//   checks it first. Which dwarves are "promoted" is a stable hash of
//   their entity id, so the same dwarves keep the same leaning.
//
// Both rules are deterministic (no RNG draw), so they don't perturb the
// seeded simulation stream.

import { JobKind } from "../ecs/components";
import { EntityId } from "../ecs/world";
import { SliderState } from "../sliders";
import { SimWorld } from "../world/simWorld";

export type LaborCategory =
  | "excavation"
  | "hauling"
  | "construction"
  | "crafting"
  | "farming"
  | "military"
  | "research"
  | "medicine";

export const LABOR_CATEGORIES: ReadonlyArray<LaborCategory> = [
  "excavation",
  "hauling",
  "construction",
  "crafting",
  "farming",
  "military",
  "research",
  "medicine",
];

/** Which slider a job kind counts against. Kinds not listed (needs,
 * shelter, socialising, wandering…) are outside the labour split. */
export const JOB_CATEGORY: Partial<Record<JobKind, LaborCategory>> = {
  mine: "excavation",
  haul: "hauling",
  maintain: "construction",
  craft: "crafting",
  engrave: "crafting",
  tend: "farming",
  train: "military",
  research: "research",
  treat: "medicine",
};

/** Slider value at or below which a category is switched off. */
export const SLIDER_OFF = 0.05;
export const SLIDER_NEUTRAL = 0.5;

/** Minimum working age — mirrors chooseTask's gate. */
const MIN_WORK_AGE = 18;

interface LaborSnapshot {
  tick: number;
  workers: number;
  counts: Record<LaborCategory, number>;
}

const cache = new WeakMap<SimWorld, LaborSnapshot>();

function emptyCounts(): Record<LaborCategory, number> {
  return {
    excavation: 0,
    hauling: 0,
    construction: 0,
    crafting: 0,
    farming: 0,
    military: 0,
    research: 0,
    medicine: 0,
  };
}

/** Per-category head-count of dwarves currently on a job, plus the
 * working-age population. Computed once per tick and cached; jobs
 * handed out earlier in the same tick are added via noteAssigned so
 * a whole idle cohort can't blow through a cap in one tick. */
export function laborSnapshot(sim: SimWorld): LaborSnapshot {
  const hit = cache.get(sim);
  if (hit && hit.tick === sim.tick) return hit;
  const counts = emptyCounts();
  let workers = 0;
  for (const e of sim.dwarf.entities) {
    if (sim.ageOf(e) >= MIN_WORK_AGE) workers++;
    const job = sim.job.get(e);
    const cat = job ? JOB_CATEGORY[job.kind] : undefined;
    if (cat) counts[cat]++;
    else if (sim.carrying.has(e)) counts.hauling++;
  }
  const snap = { tick: sim.tick, workers, counts };
  cache.set(sim, snap);
  return snap;
}

/** Record a job assignment made this tick against the cached counts. */
export function noteAssigned(sim: SimWorld, kind: JobKind): void {
  const cat = JOB_CATEGORY[kind];
  if (!cat) return;
  laborSnapshot(sim).counts[cat]++;
}

/** Max workers allowed in a category, or Infinity when uncapped. */
export function categoryCap(sim: SimWorld, cat: LaborCategory): number {
  const s = sim.sliders[cat];
  if (s <= SLIDER_OFF) return 0;
  if (s >= SLIDER_NEUTRAL) return Infinity;
  const { workers } = laborSnapshot(sim);
  return Math.max(1, Math.ceil(workers * (s / SLIDER_NEUTRAL)));
}

/** True when another dwarf may take up work in this category. */
export function categoryOpen(sim: SimWorld, cat: LaborCategory): boolean {
  const cap = categoryCap(sim, cat);
  if (cap === Infinity) return true;
  return laborSnapshot(sim).counts[cat] < cap;
}

/** Stable [0, 1) hash of an entity id (Knuth multiplicative). */
function entityFraction(e: EntityId): number {
  return (Math.imul(e + 1, 2654435761) >>> 0) / 4294967296;
}

/** Categories this dwarf should check before the normal cascade,
 * strongest slider first. Empty at neutral settings. */
export function promotedCategories(sim: SimWorld, e: EntityId): LaborCategory[] {
  const out: LaborCategory[] = [];
  const f = entityFraction(e);
  for (const cat of LABOR_CATEGORIES) {
    const s = sim.sliders[cat];
    if (s > SLIDER_NEUTRAL && f < (s - SLIDER_NEUTRAL) * 2) out.push(cat);
  }
  out.sort((a, b) => sim.sliders[b] - sim.sliders[a]);
  return out;
}

/** Hauler cap scaling: neutral keeps the base cap, above-neutral grows
 * it up to 2× at 1.0. Below neutral the generic category cap applies. */
export function haulerCapScale(sliders: SliderState): number {
  return sliders.hauling > SLIDER_NEUTRAL ? sliders.hauling / SLIDER_NEUTRAL : 1;
}
