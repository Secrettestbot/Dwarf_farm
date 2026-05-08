// Emergency buttons (GDD §4.3). The player has three coarse colony-wide
// levers that override the autonomous decision loop. Each is large,
// instant, and timed — they're the only direct action available in an
// otherwise hands-off game.
//
// Active wiring this session:
// - Alarm: civilians shelter at the spawn, military rallies (when
//   military squads land in Session 5, this gains its full meaning).
// - Evacuate: every dwarf paths to the Safe Zone (currently the spawn
//   tile). Until cancelled by the player.
// - Lockdown: blocks immigrant arrivals. Caravan + door interactions
//   land alongside trade in Session 6 and rooms-with-doors later.

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
}

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
