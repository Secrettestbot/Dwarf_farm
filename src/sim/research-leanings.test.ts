import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import { ALL_TOPICS, chooseNextTopic, defaultResearch, nextTopic, setLeaning } from "./research";

const NO_MATERIALS = { cumulative: {}, discovered: new Set<number>() };

describe("research leanings", () => {
  it("with no leanings, scholars pick exactly what the old rule picked", () => {
    const r = defaultResearch();
    // basic_brewing / basic_cooking are the 500-cost Tier 1 topics;
    // basic_brewing wins the id tie-break.
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_brewing");
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe(nextTopic(r, NO_MATERIALS)?.id);
  });

  it("a favoured topic usually comes next", () => {
    const r = defaultResearch();
    setLeaning(r, "basic_carpentry", "favoured"); // 600 × 0.35 = 210 < 500
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_carpentry");
  });

  it("a neglected topic is put off, but never blocked", () => {
    const r = defaultResearch();
    setLeaning(r, "basic_brewing", "neglected");
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_cooking");
    // Neglect everything: the scholars still study something.
    for (const t of ALL_TOPICS) setLeaning(r, t.id, "neglected");
    expect(chooseNextTopic(r, NO_MATERIALS)).not.toBeNull();
  });

  it("a favoured topic that isn't available yet doesn't stall research", () => {
    const r = defaultResearch();
    setLeaning(r, "iron_smelting", "favoured"); // gated on 3 ore mined
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_brewing");
    // Once the gate opens, the leaning applies.
    expect(chooseNextTopic(r, { cumulative: { ore: 3 }, discovered: new Set() })?.id).toBe("iron_smelting");
  });

  it("setLeaning toggles, clears, and refuses completed or unknown topics", () => {
    const r = defaultResearch();
    expect(setLeaning(r, "basic_carpentry", "favoured")).toBe(true);
    expect(setLeaning(r, "basic_carpentry", "favoured")).toBe(false);
    expect(setLeaning(r, "basic_carpentry", "neglected")).toBe(true);
    expect(r.leanings).toEqual({ basic_carpentry: "neglected" });
    expect(setLeaning(r, "basic_carpentry", null)).toBe(true);
    expect(r.leanings).toEqual({});
    r.completed.push("basic_cooking");
    expect(setLeaning(r, "basic_cooking", "favoured")).toBe(false);
    expect(setLeaning(r, "not_a_topic", "favoured")).toBe(false);
  });

  it("leanings never interrupt the topic in hand", () => {
    const w = generateWorld({ seed: 4402, width: 200, height: 500 });
    const sim = new SimWorld(4402, w.grid, w.surfaceY, w.spawn);
    sim.research.current = "basic_brewing";
    sim.research.progress = 10;
    setLeaning(sim.research, "basic_carpentry", "favoured");
    setLeaning(sim.research, "basic_brewing", "neglected");
    tick(sim);
    expect(sim.research.current).toBe("basic_brewing");
  });

  it("the auto-pick follows leanings and resumes progress banked by older builds", () => {
    const w = generateWorld({ seed: 4401, width: 200, height: 500 });
    const sim = new SimWorld(4401, w.grid, w.surfaceY, w.spawn);
    setLeaning(sim.research, "basic_carpentry", "favoured");
    sim.research.progressById = { basic_carpentry: 321 };
    tick(sim);
    expect(sim.research.current).toBe("basic_carpentry");
    expect(sim.research.progress).toBe(321);
    expect(sim.research.progressById).toEqual({});
    expect(sim.events.events.some((e) => e.text.includes("return to their study of Basic Carpentry"))).toBe(true);
  });

  it("every topic has a non-empty effect description", () => {
    for (const t of ALL_TOPICS) expect(t.effect.length).toBeGreaterThan(0);
  });
});
