// Player-controlled HUD visibility. One master "hide all overlays"
// toggle that every persistent on-screen panel (HUD info bar,
// sliders, event log, emergency banner, notifications, inspector,
// minimap, activity glyphs) listens to. Persisted via localStorage
// so the player's choice survives reloads.
//
// Indirect-control shape: the player doesn't lose any agency by
// hiding the HUD — they can still pan, zoom, click dwarves, and
// the sim runs the same. Press H or click the floating "Show HUD"
// chip to bring everything back.

const STORAGE_KEY = "hudHidden";

type Listener = (hidden: boolean) => void;
const listeners = new Set<Listener>();

let hudHidden = readInitialState();

function readInitialState(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persist(): void {
  try {
    if (hudHidden) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage might be unavailable (private browsing); the
    // setting still applies for this session.
  }
}

/** True iff the player has chosen to hide the persistent overlay
 * panels. New panels should call onHudVisibilityChange in their
 * constructor and immediately apply isHudHidden() to their root. */
export function isHudHidden(): boolean {
  return hudHidden;
}

export function setHudHidden(hidden: boolean): void {
  if (hudHidden === hidden) return;
  hudHidden = hidden;
  persist();
  for (const fn of listeners) fn(hidden);
}

export function toggleHud(): void {
  setHudHidden(!hudHidden);
}

/** Subscribe to visibility changes. Returns an unsubscribe function. */
export function onHudVisibilityChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply the hidden flag to an element's display style. Returns
 * the element so callers can chain. Convenience wrapper that
 * remembers each panel's original `display` value so unrelated
 * inline styles (flex, grid, etc.) stay intact when toggled. */
const originalDisplay = new WeakMap<HTMLElement, string>();
export function applyHudVisibility(el: HTMLElement, hidden: boolean): void {
  if (!originalDisplay.has(el)) {
    originalDisplay.set(el, el.style.display || "");
  }
  el.style.display = hidden ? "none" : originalDisplay.get(el)!;
}

/** Wire a panel's root element to follow the global HUD-hidden
 * flag. Applies the current state immediately and subscribes for
 * future changes. Returns an unsubscribe function the panel's
 * destroy() can call. */
export function attachHudVisibility(el: HTMLElement): () => void {
  applyHudVisibility(el, hudHidden);
  return onHudVisibilityChange((hidden) => applyHudVisibility(el, hidden));
}

/** Bind the global H keyboard shortcut so the player can toggle
 * the HUD from anywhere. Skipped if any text input is focused so
 * typing "h" into the fortress-rename prompt doesn't fire. */
export function installHudHotkey(): void {
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "h" && ev.key !== "H") return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    ev.preventDefault();
    toggleHud();
  });
}
