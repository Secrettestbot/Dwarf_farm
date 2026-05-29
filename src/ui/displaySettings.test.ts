import { describe, it, expect, beforeEach } from "vitest";
import {
  MINIMAP_DEFAULT,
  MINIMAP_HEIGHT_RANGE,
  MINIMAP_WIDTH_RANGE,
  PANELS,
  PanelId,
  anyPanelVisible,
  getMinimapDimensions,
  hideAllPanels,
  isPanelVisible,
  onMinimapDimensionsChange,
  onPanelVisibilityChange,
  setMinimapDimensions,
  setPanelVisible,
  showAllPanels,
  togglePanel,
  toggleAllPanels,
} from "./displaySettings";

// node test environment — no DOM. Exercises the pub/sub +
// per-panel state logic; the attachPanelVisibility helper that
// flips an element's display style is covered by manual playtest.

describe("HUD per-panel visibility", () => {
  beforeEach(() => {
    // Reset every panel to visible between cases.
    showAllPanels();
  });

  it("setPanelVisible flips one panel's flag and fires only that panel's listeners", () => {
    const sliderSeen: boolean[] = [];
    const eventLogSeen: boolean[] = [];
    const ua = onPanelVisibilityChange("sliders", (v) => sliderSeen.push(v));
    const ub = onPanelVisibilityChange("eventLog", (v) => eventLogSeen.push(v));
    setPanelVisible("sliders", false);
    expect(isPanelVisible("sliders")).toBe(false);
    expect(isPanelVisible("eventLog")).toBe(true); // unaffected
    expect(sliderSeen).toEqual([false]);
    expect(eventLogSeen).toEqual([]);
    ua(); ub();
  });

  it("togglePanel flips a single flag in place", () => {
    expect(isPanelVisible("minimap")).toBe(true);
    togglePanel("minimap");
    expect(isPanelVisible("minimap")).toBe(false);
    togglePanel("minimap");
    expect(isPanelVisible("minimap")).toBe(true);
  });

  it("setPanelVisible with the current value is a no-op (no listener fires)", () => {
    const seen: boolean[] = [];
    const unsub = onPanelVisibilityChange("hud", (v) => seen.push(v));
    setPanelVisible("hud", true); // already true
    expect(seen).toEqual([]);
    unsub();
  });

  it("hideAllPanels + showAllPanels affect every panel", () => {
    hideAllPanels();
    for (const p of PANELS) expect(isPanelVisible(p.id)).toBe(false);
    expect(anyPanelVisible()).toBe(false);
    showAllPanels();
    for (const p of PANELS) expect(isPanelVisible(p.id)).toBe(true);
    expect(anyPanelVisible()).toBe(true);
  });

  it("toggleAllPanels collapses everything if anything is visible, else restores all", () => {
    // Mixed state: hide sliders only.
    setPanelVisible("sliders", false);
    expect(anyPanelVisible()).toBe(true);
    toggleAllPanels(); // still some visible → hide everything
    for (const p of PANELS) expect(isPanelVisible(p.id)).toBe(false);
    toggleAllPanels(); // none visible → show everything
    for (const p of PANELS) expect(isPanelVisible(p.id)).toBe(true);
  });

  it("unsubscribing stops the listener from firing", () => {
    let count = 0;
    const unsub = onPanelVisibilityChange("hud", () => count++);
    togglePanel("hud");
    expect(count).toBe(1);
    unsub();
    togglePanel("hud");
    expect(count).toBe(1);
  });

  it("PANELS lists every PanelId exactly once", () => {
    const seen = new Set<PanelId>();
    for (const p of PANELS) {
      expect(seen.has(p.id)).toBe(false);
      seen.add(p.id);
    }
  });
});

describe("minimap dimensions", () => {
  beforeEach(() => setMinimapDimensions(MINIMAP_DEFAULT));

  it("setMinimapDimensions fires the listener only when a value actually changes", () => {
    const seen: Array<{ width: number; height: number }> = [];
    const unsub = onMinimapDimensionsChange((d) => seen.push(d));
    setMinimapDimensions({ width: 200, height: 80 }); // no-op
    setMinimapDimensions({ width: 300 });
    setMinimapDimensions({ width: 300 }); // no-op
    setMinimapDimensions({ height: 120 });
    expect(seen).toEqual([
      { width: 300, height: 80 },
      { width: 300, height: 120 },
    ]);
    expect(getMinimapDimensions()).toEqual({ width: 300, height: 120 });
    unsub();
  });

  it("dimensions are clamped to the configured ranges", () => {
    setMinimapDimensions({ width: 999, height: 5 });
    const d = getMinimapDimensions();
    expect(d.width).toBe(MINIMAP_WIDTH_RANGE.max);
    expect(d.height).toBe(MINIMAP_HEIGHT_RANGE.min);
  });

  it("aspect ratio is whatever the player picked — not locked to a square", () => {
    setMinimapDimensions({ width: 400, height: 50 });
    const d1 = getMinimapDimensions();
    expect(d1.width / d1.height).toBeCloseTo(8, 1);
    setMinimapDimensions({ width: 100, height: 200 });
    const d2 = getMinimapDimensions();
    expect(d2.width / d2.height).toBeCloseTo(0.5, 2);
  });

  it("getMinimapDimensions returns a copy — mutating it doesn't change state", () => {
    setMinimapDimensions({ width: 220, height: 90 });
    const d = getMinimapDimensions();
    d.width = 999;
    expect(getMinimapDimensions().width).toBe(220);
  });
});
