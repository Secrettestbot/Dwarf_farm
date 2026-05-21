import { SpriteSet, setSpriteSet } from "./sprites";

// Persisted via localStorage so the player's choice survives a
// reload. Decoupled from the sprite pool itself (./sprites.ts) so
// the title screen's bunny button can write the preference without
// importing the renderer.

const STORAGE_KEY = "spriteSet";

function isSpriteSet(v: string | null): v is SpriteSet {
  return v === "dwarves" || v === "mixed" || v === "bunnies";
}

/** Read the player's chosen sprite set from localStorage. Defaults
 * to the dwarf-variety pool (no bunnies) for first-time players. */
export function loadSpriteSet(): SpriteSet {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isSpriteSet(v)) return v;
  } catch {
    // localStorage not available (e.g. private mode) — fall through.
  }
  return "dwarves";
}

/** Persist the player's chosen sprite set and apply it to the live
 * sprite pool so the next render reflects the change immediately. */
export function saveSpriteSet(set: SpriteSet): void {
  try {
    localStorage.setItem(STORAGE_KEY, set);
  } catch {
    // localStorage not available — applying to the pool still
    // works for the current session.
  }
  setSpriteSet(set);
}

/** Convenience: pull the stored preference and apply it to the
 * sprite pool. Called once at game start so reloads honour the
 * player's previous choice without forcing them through the title
 * screen toggle every time. */
export function applyStoredSpriteSet(): void {
  setSpriteSet(loadSpriteSet());
}
