// Per-panel HUD visibility. Each persistent overlay (HUD info bar,
// sliders, event log, emergency banner, notifications, minimap)
// has its own visible / hidden flag the player can toggle from the
// Display popover in the HUD. A master "show all / hide all"
// shortcut (H key) flips the lot in one go.
//
// Indirect-control shape: visibility only changes what the player
// sees; the sim runs the same regardless.

const STORAGE_KEY = "hudVisibility";
const MINIMAP_DIMENSIONS_KEY = "minimapDimensions";
/** Migrate the old enum-style key written by the
 * Small/Medium/Large/Huge version. Mapping uses the same
 * multipliers that release shipped with. */
const LEGACY_MINIMAP_SCALE_KEY = "minimapScale";
const LEGACY_MINIMAP_SCALE_MULTIPLIERS: Record<string, number> = {
  small: 0.5,
  medium: 1.0,
  large: 1.5,
  huge: 2.0,
};
/** Older single-boolean key from the all-or-nothing version. We
 * migrate from this on first read so an existing player doesn't
 * lose their "everything hidden" preference. */
const LEGACY_STORAGE_KEY = "hudHidden";

export type PanelId =
  | "hud"
  | "sliders"
  | "eventLog"
  | "emergency"
  | "notifications"
  | "minimap";

/** Minimap dimensions in screen pixels. The player sets width
 * and height independently from the Display popover sliders —
 * intentionally NOT locked to world aspect, so they can stretch
 * or squish the minimap to fit whatever shape their HUD layout
 * leaves. The minimap samples the world independently along
 * each axis, so a 400×40 strip and a 100×200 column both show
 * the whole world, just stretched. */
export interface MinimapDimensions {
  width: number;
  height: number;
}

export const MINIMAP_DEFAULT: MinimapDimensions = { width: 200, height: 80 };
export const MINIMAP_WIDTH_RANGE: { min: number; max: number } = { min: 80, max: 500 };
export const MINIMAP_HEIGHT_RANGE: { min: number; max: number } = { min: 40, max: 300 };

function clampMinimapDimensions(d: Partial<MinimapDimensions>): MinimapDimensions {
  const w = Math.round(d.width ?? MINIMAP_DEFAULT.width);
  const h = Math.round(d.height ?? MINIMAP_DEFAULT.height);
  return {
    width: Math.max(MINIMAP_WIDTH_RANGE.min, Math.min(MINIMAP_WIDTH_RANGE.max, w)),
    height: Math.max(MINIMAP_HEIGHT_RANGE.min, Math.min(MINIMAP_HEIGHT_RANGE.max, h)),
  };
}

/** Ordered list of panels for the Display popover UI. The order
 * here is the order checkboxes render in. */
export const PANELS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: "hud", label: "HUD info & tools" },
  { id: "sliders", label: "Priority sliders" },
  { id: "eventLog", label: "Event log" },
  { id: "emergency", label: "Emergency buttons" },
  { id: "notifications", label: "Notification toasts" },
  { id: "minimap", label: "Minimap" },
];

type Listener = (visible: boolean) => void;
const listeners: Map<PanelId, Set<Listener>> = new Map();

function defaultVisibility(): Record<PanelId, boolean> {
  return {
    hud: true,
    sliders: true,
    eventLog: true,
    emergency: true,
    notifications: true,
    minimap: true,
  };
}

let visibility: Record<PanelId, boolean> = readInitialState();

function readInitialState(): Record<PanelId, boolean> {
  const base = defaultVisibility();
  try {
    // Migrate the legacy single-boolean key. If it was "1" (hidden
    // mode), set every panel hidden. Then delete the legacy key so
    // the new format owns the preference going forward.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === "1") {
      for (const p of PANELS) base[p.id] = false;
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(base));
      return base;
    }
    if (legacy !== null) localStorage.removeItem(LEGACY_STORAGE_KEY);

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const p of PANELS) {
        if (typeof parsed[p.id] === "boolean") base[p.id] = parsed[p.id];
      }
    }
  } catch {
    // localStorage unavailable or malformed JSON — defaults stand.
  }
  return base;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // Best-effort persistence.
  }
}

export function isPanelVisible(id: PanelId): boolean {
  return visibility[id];
}

export function setPanelVisible(id: PanelId, visible: boolean): void {
  if (visibility[id] === visible) return;
  visibility[id] = visible;
  persist();
  const subs = listeners.get(id);
  if (subs) for (const fn of subs) fn(visible);
}

export function togglePanel(id: PanelId): void {
  setPanelVisible(id, !visibility[id]);
}

/** Master controls. "Hide all" sets every panel to hidden; "Show all"
 * brings them back; "Toggle all" inspects current state — if anything
 * is visible it hides everything, otherwise it shows everything.
 * Toggle-all is what the H keyboard shortcut binds to. */
export function hideAllPanels(): void {
  for (const p of PANELS) setPanelVisible(p.id, false);
}

export function showAllPanels(): void {
  for (const p of PANELS) setPanelVisible(p.id, true);
}

export function anyPanelVisible(): boolean {
  for (const p of PANELS) if (visibility[p.id]) return true;
  return false;
}

export function toggleAllPanels(): void {
  if (anyPanelVisible()) hideAllPanels();
  else showAllPanels();
}

/** Subscribe to one panel's visibility changes. */
export function onPanelVisibilityChange(id: PanelId, fn: Listener): () => void {
  let subs = listeners.get(id);
  if (!subs) {
    subs = new Set();
    listeners.set(id, subs);
  }
  subs.add(fn);
  return () => subs!.delete(fn);
}

/** Apply the visible flag to an element's display style, restoring
 * the original (flex / grid / "") inline value when unhiding. */
const originalDisplay = new WeakMap<HTMLElement, string>();
function applyVisibility(el: HTMLElement, visible: boolean): void {
  if (!originalDisplay.has(el)) {
    originalDisplay.set(el, el.style.display || "");
  }
  el.style.display = visible ? originalDisplay.get(el)! : "none";
}

/** Wire a panel's root element to follow its visibility flag.
 * Applies the current state immediately and subscribes for future
 * changes. Returns an unsubscribe function. */
export function attachPanelVisibility(id: PanelId, el: HTMLElement): () => void {
  applyVisibility(el, visibility[id]);
  return onPanelVisibilityChange(id, (visible) => applyVisibility(el, visible));
}

// ---- Minimap dimensions --------------------------------------------

let minimapDimensions: MinimapDimensions = readInitialMinimapDimensions();
const minimapDimensionsListeners = new Set<(d: MinimapDimensions) => void>();

function readInitialMinimapDimensions(): MinimapDimensions {
  try {
    const raw = localStorage.getItem(MINIMAP_DIMENSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return clampMinimapDimensions(parsed);
      }
    }
    // Migrate the prior Small/Medium/Large/Huge enum if present —
    // multiply the default dimensions by the matching multiplier
    // so a player who picked "Huge" keeps a huge minimap.
    const legacy = localStorage.getItem(LEGACY_MINIMAP_SCALE_KEY);
    if (legacy && LEGACY_MINIMAP_SCALE_MULTIPLIERS[legacy] !== undefined) {
      const mult = LEGACY_MINIMAP_SCALE_MULTIPLIERS[legacy];
      const migrated = clampMinimapDimensions({
        width: MINIMAP_DEFAULT.width * mult,
        height: MINIMAP_DEFAULT.height * mult,
      });
      try {
        localStorage.setItem(MINIMAP_DIMENSIONS_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_MINIMAP_SCALE_KEY);
      } catch { /* best effort */ }
      return migrated;
    }
  } catch {
    // localStorage unavailable or malformed JSON — defaults stand.
  }
  return { ...MINIMAP_DEFAULT };
}

export function getMinimapDimensions(): MinimapDimensions {
  return { ...minimapDimensions };
}

export function setMinimapDimensions(d: Partial<MinimapDimensions>): void {
  const next = clampMinimapDimensions({
    width: d.width ?? minimapDimensions.width,
    height: d.height ?? minimapDimensions.height,
  });
  if (next.width === minimapDimensions.width && next.height === minimapDimensions.height) return;
  minimapDimensions = next;
  try {
    localStorage.setItem(MINIMAP_DIMENSIONS_KEY, JSON.stringify(next));
  } catch {
    // Best-effort persistence.
  }
  for (const fn of minimapDimensionsListeners) fn({ ...next });
}

export function onMinimapDimensionsChange(fn: (d: MinimapDimensions) => void): () => void {
  minimapDimensionsListeners.add(fn);
  return () => minimapDimensionsListeners.delete(fn);
}

/** Bind the global H keyboard shortcut to toggle every panel.
 * Skipped if any text input is focused so typing "h" into a
 * rename prompt doesn't fire the shortcut. */
export function installHudHotkey(): void {
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "h" && ev.key !== "H") return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    ev.preventDefault();
    toggleAllPanels();
  });
}
