// Goblin warband morale (siege rework). A siege ends when the warband
// loses heart, not on a fixed timer. Morale starts at 100 and is
// derived from siege state rather than accumulated tick by tick, so it
// survives save/load and time jumps exactly:
//
//   morale = 100 − rate × days besieged
//                − losses × (LOSS_PENALTY_TOTAL / warband size)
//                + dwarves slain × PLUNDER_BONUS
//
// Waiting behind sealed gates drains it slowly; bleeding the warband at
// the gate (a sortie) breaks it much faster; giving it easy kills
// keeps it going. Winter and Fortification Design make it drain faster.

import { SimWorld } from "../world/simWorld";
import { seasonOf, TICKS_PER_DAY } from "../time";

/** Morale lost per day besieged with nothing to show for it — a
 * warband that achieves nothing breaks in just under 7 days. */
export const MORALE_DECAY_PER_DAY = 15;
/** Multiplier on the daily drain in winter: cold camps empty fast. */
export const WINTER_DECAY_FACTOR = 1.5;
/** Fortification Design (Tier 3): a fortress built to be held saps a
 * warband's will — daily drain ×1.5. */
export const FORTIFIED_DECAY_FACTOR = 1.5;
/** Morale lost if the whole warband were cut down, spread per goblin
 * (losing a third of the band costs ~23). */
export const LOSS_PENALTY_TOTAL = 70;
/** Morale regained per dwarf the warband kills. */
export const PLUNDER_BONUS = 6;
/** Chronicle beats as morale falls past these levels. */
const MORALE_BEATS = [60, 30];

export function siegeMoraleRate(sim: SimWorld): number {
  let rate = MORALE_DECAY_PER_DAY;
  if (seasonOf(sim.tick) === "winter") rate *= WINTER_DECAY_FACTOR;
  if (sim.research.completed.includes("fortification_design")) rate *= FORTIFIED_DECAY_FACTOR;
  return rate;
}

/** Current warband morale (may go below 0 the tick it breaks). */
export function siegeMorale(sim: SimWorld): number {
  if (!sim.siegeActive || sim.siegeStartedAtTick < 0) return 100;
  const days = (sim.tick - sim.siegeStartedAtTick) / TICKS_PER_DAY;
  const size = Math.max(1, sim.siegeInitialSize);
  return (
    100
    - siegeMoraleRate(sim) * days
    - sim.siegeGoblinsLost * (LOSS_PENALTY_TOTAL / size)
    + sim.siegeDwarvesSlain * PLUNDER_BONUS
  );
}

/** Reset the morale bookkeeping as a warband arrives. */
export function beginSiegeMorale(sim: SimWorld, warbandSize: number): void {
  sim.siegeInitialSize = warbandSize;
  sim.siegeGoblinsLost = 0;
  sim.siegeDwarvesSlain = 0;
  sim.siegeMoraleBeat = 0;
}

/** Chronicle the warband's wavering as morale passes each beat.
 * Returns true once morale has broken (≤ 0). */
export function siegeMoraleCheck(sim: SimWorld): boolean {
  const m = siegeMorale(sim);
  while (sim.siegeMoraleBeat < MORALE_BEATS.length && m < MORALE_BEATS[sim.siegeMoraleBeat]) {
    sim.events.add(
      sim.tick,
      "crisis",
      sim.siegeMoraleBeat === 0
        ? "The goblins outside are growing restless. Fires burn low in their camp and the arguing carries on the wind."
        : "The warband is wavering. A few goblins have already slipped away down the slopes.",
    );
    sim.siegeMoraleBeat++;
  }
  return m <= 0;
}

/** Beat level implied by a morale value (used when restoring a save). */
export function moraleBeatFor(morale: number): number {
  let beat = 0;
  while (beat < MORALE_BEATS.length && morale < MORALE_BEATS[beat]) beat++;
  return beat;
}
