// Emergency buttons (GDD §4.3). The player has three coarse colony-wide
// levers that override the autonomous decision loop. Each is large,
// instant, and timed — they're the only direct action available in an
// otherwise hands-off game.
//
// - Alarm: civilians drop work and shelter in the Safe Zone; soldiers
//   without a target rally at the entrance. Auto-cancels after an hour.
// - Evacuate: every dwarf, soldiers included, withdraws to the Safe
//   Zone until cancelled.
// - Lockdown: the openings between the fortress and the surface are
//   sealed (internal doors are untouched); migrants camp outside and
//   caravans hold off until it lifts.
//
// The Safe Zone is chosen automatically when shelter begins: the
// deepest finished room reachable from the entrance (systems/emergency.ts).

import { TICKS_PER_HOUR } from "./time";

export type EmergencyMode = "none" | "alarm" | "evacuate" | "lockdown";

export interface EmergencyState {
  mode: EmergencyMode;
  /** Tick at which the current mode was triggered. */
  startedAtTick: number;
  /** Tick before which a new mode of the same kind cannot be triggered.
   * Tracked per kind so an Alarm cooldown doesn't block Evacuate. */
  alarmCooldownUntil: number;
  evacuateCooldownUntil: number;
  /** Safe Zone chosen for the current shelter episode — a finished
   * room's blueprint id, or -1 for the entrance fallback. Optional for
   * back-compat with older saves. */
  safeZoneId?: number;
  /** Tiles sealed by the current Lockdown as packed [x, y, tile]
   * triples, so lifting it restores exactly what was there. */
  sealed?: number[];
  /** Tick until which a migrant party waits outside a Lockdown; 0 when
   * none is camped. */
  migrantsCampUntil?: number;
}

/** Migrants give up on a sealed fortress after three in-game days. */
export const MIGRANT_CAMP_TICKS = TICKS_PER_HOUR * 24 * 3;

export const ALARM_DURATION_TICKS = TICKS_PER_HOUR; // 1 in-game hour
export const ALARM_COOLDOWN_TICKS = TICKS_PER_HOUR * 4;
export const EVACUATE_COOLDOWN_TICKS = TICKS_PER_HOUR * 8;

export function defaultEmergency(): EmergencyState {
  return {
    mode: "none",
    startedAtTick: 0,
    alarmCooldownUntil: 0,
    evacuateCooldownUntil: 0,
  };
}

/** True if the colony is currently sheltering or evacuating — i.e. dwarves
 * should drop work and head to the Safe Zone. */
export function isShelterMode(s: EmergencyState): boolean {
  return s.mode === "alarm" || s.mode === "evacuate";
}
