import { describe, it, expect, beforeEach } from "vitest";
import {
  isHudHidden,
  onHudVisibilityChange,
  setHudHidden,
  toggleHud,
} from "./displaySettings";

// node test environment — no DOM. We exercise the pub/sub +
// persistence logic only; the applyHudVisibility / attachHudVisibility
// DOM-touching helpers are covered by manual playtest.

describe("HUD display settings", () => {
  beforeEach(() => {
    setHudHidden(false); // reset between cases
  });

  it("toggleHud flips isHudHidden and fires listeners", () => {
    const seen: boolean[] = [];
    const unsub = onHudVisibilityChange((h) => seen.push(h));
    toggleHud();
    expect(isHudHidden()).toBe(true);
    toggleHud();
    expect(isHudHidden()).toBe(false);
    expect(seen).toEqual([true, false]);
    unsub();
  });

  it("setHudHidden with the current value is a no-op (no listener fires)", () => {
    const seen: boolean[] = [];
    const unsub = onHudVisibilityChange((h) => seen.push(h));
    setHudHidden(false); // already false
    expect(seen).toEqual([]);
    unsub();
  });

  it("unsubscribing stops the listener from firing", () => {
    let count = 0;
    const unsub = onHudVisibilityChange(() => count++);
    toggleHud();
    expect(count).toBe(1);
    unsub();
    toggleHud();
    expect(count).toBe(1); // unchanged after unsubscribe
  });

  it("multiple listeners all see the change", () => {
    const a: boolean[] = [];
    const b: boolean[] = [];
    const ua = onHudVisibilityChange((h) => a.push(h));
    const ub = onHudVisibilityChange((h) => b.push(h));
    toggleHud();
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);
    ua(); ub();
  });
});
