// Tick scheduler. 1 tick = 1 in-game minute. At 1× the simulation runs 6 ticks
// per real second (so 1 in-game hour ≈ 10 real seconds, matching GDD §3.1).

export const TICKS_PER_SECOND_AT_1X = 6;
export const TICKS_PER_HOUR = 60;
export const TICKS_PER_DAY = TICKS_PER_HOUR * 24;

// GDD §3.1: 1 in-game year ≈ 96 real minutes at 1× = 4 in-game seasons of
// ~24 real minutes (~6 in-game days each), so 24 in-game days per year.
// Dwarves age accordingly (founders age 25 = 25 × TICKS_PER_YEAR ago).
export const TICKS_PER_YEAR = TICKS_PER_DAY * 24;

export const SPEED_LEVELS = [0, 1, 4, 16] as const;
export type SpeedLevel = (typeof SPEED_LEVELS)[number];

/**
 * Drives ticking from real-time deltas. The catch-up worker bypasses this and
 * just calls `tick()` in a tight loop.
 */
export class Clock {
  /** Total in-game ticks elapsed since world creation. */
  tick = 0;
  speed: SpeedLevel = 1;
  private accumulator = 0;

  /**
   * Given real-time elapsed (ms), returns how many ticks to run this frame and
   * advances the internal counter.
   */
  consume(realDtMs: number): number {
    if (this.speed === 0) return 0;
    this.accumulator += (realDtMs / 1000) * TICKS_PER_SECOND_AT_1X * this.speed;
    const whole = Math.floor(this.accumulator);
    this.accumulator -= whole;
    this.tick += whole;
    return whole;
  }

  /** Used by catch-up: directly advances the tick counter. */
  advanceTicks(n: number): void {
    this.tick += n;
  }

  setSpeed(s: SpeedLevel): void {
    this.speed = s;
  }
}
