import { describe, it, expect } from "vitest";
import { generateWorld } from "./world/worldgen";
import { SimWorld } from "./world/simWorld";
import { tick } from "./sim";
import {
  ALL_TOPICS,
  chooseNextTopic,
  defaultResearch,
  queueTopic,
  switchTopic,
  topicProgressFraction,
  TOPICS_BY_ID,
} from "./research";

const NO_MATERIALS = { cumulative: {}, discovered: new Set<number>() };

describe("research queue selection", () => {
  it("falls back to the cheapest available topic when nothing is queued", () => {
    const r = defaultResearch();
    // basic_brewing / basic_cooking are the 500-cost Tier 1 topics;
    // basic_brewing wins the id tie-break.
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_brewing");
  });

  it("prefers the player's queued topic when it is available", () => {
    const r = defaultResearch();
    r.queued = "rope_and_fibre";
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("rope_and_fibre");
  });

  it("ignores a queued topic whose prereqs are unmet", () => {
    const r = defaultResearch();
    r.queued = "masonry_and_mortaring"; // needs basic_stonecutting
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_brewing");
    r.completed = ["basic_stonecutting"];
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("masonry_and_mortaring");
  });

  it("ignores a queued topic whose material gate is unmet", () => {
    const r = defaultResearch();
    r.queued = "iron_smelting"; // needs 3 ore
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_brewing");
    expect(chooseNextTopic(r, { cumulative: { ore: 3 }, discovered: new Set() })?.id).toBe("iron_smelting");
  });

  it("ignores a queued topic that is already complete", () => {
    const r = defaultResearch();
    r.queued = "rope_and_fibre";
    r.completed = ["rope_and_fibre"];
    expect(chooseNextTopic(r, NO_MATERIALS)?.id).toBe("basic_brewing");
  });

  it("queueTopic only accepts available topics and toggles on a repeat click", () => {
    const r = defaultResearch();
    expect(queueTopic(r, "the_kings_name", NO_MATERIALS)).toBe(false);
    expect(r.queued).toBeNull();
    expect(queueTopic(r, "iron_smelting", NO_MATERIALS)).toBe(false); // material-gated
    expect(queueTopic(r, "basic_carpentry", NO_MATERIALS)).toBe(true);
    expect(r.queued).toBe("basic_carpentry");
    expect(queueTopic(r, "basic_carpentry", NO_MATERIALS)).toBe(true);
    expect(r.queued).toBeNull();
  });

  it("switchTopic banks the in-progress topic and restores it on return", () => {
    const r = defaultResearch();
    r.current = "basic_brewing";
    r.progress = 700;
    expect(switchTopic(r, "basic_carpentry", NO_MATERIALS)).toBe(true);
    expect(r.current).toBe("basic_carpentry");
    expect(r.progress).toBe(0);
    expect(r.progressById).toEqual({ basic_brewing: 700 });
    expect(topicProgressFraction(r, TOPICS_BY_ID["basic_brewing"])).toBeGreaterThan(0);
    r.progress = 50;
    expect(switchTopic(r, "basic_brewing", NO_MATERIALS)).toBe(true);
    expect(r.current).toBe("basic_brewing");
    expect(r.progress).toBe(700);
    expect(r.progressById).toEqual({ basic_carpentry: 50 });
    // Can't switch to a locked topic.
    expect(switchTopic(r, "steel_alloying", NO_MATERIALS)).toBe(false);
    expect(r.current).toBe("basic_brewing");
  });

  it("switchTopic clears the queue if it pointed at the new topic", () => {
    const r = defaultResearch();
    r.current = "basic_brewing";
    r.queued = "basic_cooking";
    switchTopic(r, "basic_cooking", NO_MATERIALS);
    expect(r.queued).toBeNull();
  });

  it("the auto-pick system takes the queued topic and resumes banked progress", () => {
    const w = generateWorld({ seed: 4401, width: 200, height: 500 });
    const sim = new SimWorld(4401, w.grid, w.surfaceY, w.spawn);
    sim.research.queued = "basic_carpentry";
    sim.research.progressById = { basic_carpentry: 321 };
    tick(sim);
    expect(sim.research.current).toBe("basic_carpentry");
    expect(sim.research.progress).toBe(321);
    expect(sim.research.queued).toBeNull();
    expect(sim.research.progressById).toEqual({});
    expect(sim.events.events.some((e) => e.text.includes("return to their study of Basic Carpentry"))).toBe(true);
  });

  it("a queued topic is not picked while another topic is in progress", () => {
    const w = generateWorld({ seed: 4402, width: 200, height: 500 });
    const sim = new SimWorld(4402, w.grid, w.surfaceY, w.spawn);
    sim.research.current = "basic_brewing";
    sim.research.progress = 10;
    sim.research.queued = "basic_carpentry";
    tick(sim);
    expect(sim.research.current).toBe("basic_brewing");
    expect(sim.research.queued).toBe("basic_carpentry");
  });

  it("every topic has a non-empty effect description", () => {
    for (const t of ALL_TOPICS) expect(t.effect.length).toBeGreaterThan(0);
  });
});
