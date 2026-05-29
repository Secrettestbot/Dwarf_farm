import { describe, it, expect, beforeEach } from "vitest";
import {
  PANELS,
  PanelId,
  anyPanelVisible,
  hideAllPanels,
  isPanelVisible,
  onPanelVisibilityChange,
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
