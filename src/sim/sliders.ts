// Player priority sliders (GDD §4.1). Ten sliders, each in [0, 1] with
// 0.5 as the neutral default. Sliders don't issue commands — they bias
// the autonomous decision loop in chooseTask. The eight work sliders
// reshape the labour split (see jobs/laborWeights.ts): below neutral
// they cap the share of workers on that job, above neutral they pull a
// growing share of workers toward it first, and at ≤ 5% they switch it
// off. Rest and Socialising scale the need thresholds instead.

export interface SliderState {
  /** Mining inside active blueprints. */
  excavation: number;
  /** Hauling items to stockpiles. */
  hauling: number;
  /** Room upkeep and maintenance. */
  construction: number;
  /** Workshop output and engraving. */
  crafting: number;
  /** Farming and brewing — tending plots, eventually brewing barrels. */
  farming: number;
  /** Squad drilling at armoury racks. */
  military: number;
  /** Research at the library. */
  research: number;
  /** Hospital staffing; also sets how skilled a medic must be. */
  medicine: number;
  /** Tavern, parties, conversations — bumps the social trigger threshold. */
  socialising: number;
  /** Dwarves prefer rest over work — bumps the night-rest threshold. */
  rest: number;
}

export function defaultSliders(): SliderState {
  return {
    excavation: 0.5,
    hauling: 0.5,
    construction: 0.5,
    crafting: 0.5,
    farming: 0.5,
    military: 0.5,
    research: 0.5,
    medicine: 0.5,
    socialising: 0.5,
    rest: 0.5,
  };
}

export const SLIDER_KEYS: ReadonlyArray<keyof SliderState> = [
  "excavation",
  "hauling",
  "construction",
  "crafting",
  "farming",
  "military",
  "research",
  "medicine",
  "socialising",
  "rest",
];

export const SLIDER_LABELS: Record<keyof SliderState, string> = {
  excavation: "Excavation",
  hauling: "Hauling",
  construction: "Construction",
  crafting: "Crafting",
  farming: "Farming & Brewing",
  military: "Military Training",
  research: "Research",
  medicine: "Medicine",
  socialising: "Socialising",
  rest: "Rest",
};
