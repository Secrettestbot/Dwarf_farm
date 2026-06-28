import { describe, it, expect } from "vitest";
import { siegeComposition, MAX_SIEGE_GOBLINS } from "./siegeComposition";

describe("siege composition scales with population and tier", () => {
  it("the first siege (tier 1) is a plain warband — no champions, no forced trolls", () => {
    const c = siegeComposition(12, 0);
    expect(c.championCount).toBe(0);
    // pop 12 < 25, tier 1 → no trolls at all.
    expect(c.trollCount).toBe(0);
    expect(c.goblinCount).toBe(4 + 3); // 4 + floor(12/4)
    expect(c.warlordCount).toBe(0); // pop < 15
  });

  it("a bigger colony draws a bigger raid at the same tier", () => {
    const small = siegeComposition(12, 0);
    const large = siegeComposition(36, 0);
    expect(large.goblinCount).toBeGreaterThan(small.goblinCount);
  });

  it("each surviving siege escalates the next host for the same population", () => {
    const pop = 20;
    const first = siegeComposition(pop, 0);
    const fifth = siegeComposition(pop, 4);
    // More goblins, and champions/trolls that weren't there at tier 1.
    expect(fifth.goblinCount).toBeGreaterThan(first.goblinCount);
    expect(fifth.championCount).toBeGreaterThan(first.championCount);
    expect(fifth.trollCount).toBeGreaterThanOrEqual(first.trollCount);
    // Strictly harder overall.
    const weight = (c: ReturnType<typeof siegeComposition>) =>
      c.goblinCount + c.championCount * 2 + c.trollCount * 3 + c.warlordCount * 3;
    expect(weight(fifth)).toBeGreaterThan(weight(first));
  });

  it("champions first appear at the third siege", () => {
    expect(siegeComposition(20, 0).championCount).toBe(0); // tier 1
    expect(siegeComposition(20, 1).championCount).toBe(0); // tier 2
    expect(siegeComposition(20, 2).championCount).toBe(1); // tier 3
    expect(siegeComposition(20, 3).championCount).toBe(2); // tier 4
    expect(siegeComposition(20, 10).championCount).toBe(3); // capped at 3
  });

  it("a warlord leads once the colony is worth it (pop >= 15), tier-independent", () => {
    expect(siegeComposition(14, 5).warlordCount).toBe(0);
    expect(siegeComposition(15, 0).warlordCount).toBe(1);
    expect(siegeComposition(40, 9).warlordCount).toBe(1); // never more than one
  });

  it("trolls come from colony size OR siege tier, whichever is greater", () => {
    // Small colony, low tier: no trolls.
    expect(siegeComposition(20, 0).trollCount).toBe(0);
    // Big colony, low tier: one (the pop >= 25 rule).
    expect(siegeComposition(30, 0).trollCount).toBe(1);
    // Small colony, high tier: trolls arrive as siege-engines.
    expect(siegeComposition(20, 4).trollCount).toBe(2); // tier 5 → floor(4/2)
  });

  it("goblin count is capped so a huge high-tier colony can't spawn hundreds", () => {
    const c = siegeComposition(400, 50);
    expect(c.goblinCount).toBe(MAX_SIEGE_GOBLINS);
  });

  it("treats a negative/garbage siegesSurvived as tier 1 rather than going backwards", () => {
    const c = siegeComposition(20, -3);
    expect(c.championCount).toBe(0);
    expect(c.goblinCount).toBe(4 + 5); // tier clamped to 1: 4 + floor(20/4)
  });
});
