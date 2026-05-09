// Sound pipeline: lightweight Web Audio synth keyed off the chronicle's
// EventCategory. We don't ship asset files — every effect is generated
// at runtime from oscillator + envelope so the build stays small and
// load-time stays instant. Each category gets its own little motif so
// the player can pick out a milestone fanfare from a crisis warning by
// ear without taking their eyes off the canvas.
//
// The AudioContext is created lazily on the first user interaction
// (browsers refuse to play audio before the page has been touched).
// A mute toggle is persisted in localStorage; default is sound-on.

import { EventCategory } from "../sim/events/eventLog";

const STORAGE_KEY = "dwarven-deep:muted";

let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem(STORAGE_KEY) === "1";
} catch {
  // localStorage may be unavailable in private browsing; default to unmuted.
}

function ensureCtx(): AudioContext | null {
  if (muted) return null;
  if (ctx) return ctx;
  try {
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Play a single sine note with a quick attack-decay envelope. The
 * envelope shape is fixed; only frequency, duration, and amplitude
 * vary per call. */
function note(freq: number, durSec: number, amp = 0.18, type: OscillatorType = "sine"): void {
  const c = ensureCtx();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(amp, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.02);
}

/** Play a short rising chord — used for discovery moments. */
function chord(freqs: number[], durSec: number, amp = 0.12): void {
  for (const f of freqs) note(f, durSec, amp, "sine");
}

/** One audible motif per chronicle category. Volumes are tuned so
 * milestones cut through a quiet game and crises read as alarming
 * without being grating on repeat. */
export function playEventSound(cat: EventCategory): void {
  switch (cat) {
    case "milestone":
      // Triumphant rising fanfare: C–E–G in quick succession.
      chord([523.25, 659.25, 783.99], 0.45, 0.16);
      break;
    case "crisis":
      // Low buzzy warning. Sawtooth at a tritone interval.
      note(146.83, 0.35, 0.18, "sawtooth");
      setTimeout(() => note(207.65, 0.35, 0.18, "sawtooth"), 180);
      break;
    case "discovery":
      // Bright chime — a high major-third bell.
      note(880, 0.25, 0.14);
      setTimeout(() => note(1108.73, 0.3, 0.12), 80);
      break;
    case "construction":
      // Soft click for blueprint laid / room finished.
      note(392, 0.12, 0.1, "triangle");
      break;
    case "social":
      // Gentle tone for births / pairings.
      note(587.33, 0.3, 0.1, "sine");
      break;
    case "founding":
      // Deep ceremonial tone for the founding event.
      note(196, 0.6, 0.12, "sine");
      setTimeout(() => note(293.66, 0.6, 0.1, "sine"), 200);
      break;
  }
}

/** Toggle mute. Persists to localStorage so the choice survives a
 * reload. Returns the new muted state. */
export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Persistence best-effort.
  }
  if (muted && ctx) {
    void ctx.close();
    ctx = null;
  }
}

export function isMuted(): boolean {
  return muted;
}
