// Per-panel HUD visibility. Each persistent overlay (HUD info bar,
// sliders, event log, emergency banner, notifications, minimap)
// has its own visible / hidden flag the player can toggle from the
// Display popover in the HUD. A master "show all / hide all"
// shortcut (H key) flips the lot in one go.
//
// Indirect-control shape: visibility only changes what the player
// sees; the sim runs the same regardless.

const STORAGE_KEY = "hudVisibility";
const MINIMAP_SCALE_KEY = "minimapScale";
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

/** Discrete minimap size buckets. Multipliers apply to the
 * minimap's default 200×80 target dimensions: small halves it,
 * huge doubles it. Stored alongside the panel visibility flags
 * because the Display popover surfaces both controls. */
export type MinimapScale = "small" | "medium" | "large" | "huge";

export const MINIMAP_SCALES: ReadonlyArray<{ id: MinimapScale; label: string; mult: number }> = [
  { id: "small", label: "Small", mult: 0.5 },
  { id: "medium", label: "Medium", mult: 1.0 },
  { id: "large", label: "Large", mult: 1.5 },
  { id: "huge", label: "Huge", mult: 2.0 },
];

export function minimapScaleMultiplier(s: MinimapScale): number {
  for (const entry of MINIMAP_SCALES) if (entry.id === s) return entry.mult;
  return 1.0;
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

// ---- Minimap scale --------------------------------------------------

let minimapScale: MinimapScale = readInitialMinimapScale();
const minimapScaleListeners = new Set<(s: MinimapScale) => void>();

function readInitialMinimapScale(): MinimapScale {
  try {
    const raw = localStorage.getItem(MINIMAP_SCALE_KEY);
    for (const entry of MINIMAP_SCALES) {
      if (entry.id === raw) return entry.id;
    }
  } catch {
    // localStorage unavailable.
  }
  return "medium";
}

export function getMinimapScale(): MinimapScale {
  return minimapScale;
}

export function setMinimapScale(s: MinimapScale): void {
  if (minimapScale === s) return;
  minimapScale = s;
  try {
    localStorage.setItem(MINIMAP_SCALE_KEY, s);
  } catch {
    // Best-effort persistence.
  }
  for (const fn of minimapScaleListeners) fn(s);
}

export function onMinimapScaleChange(fn: (s: MinimapScale) => void): () => void {
  minimapScaleListeners.add(fn);
  return () => minimapScaleListeners.delete(fn);
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
