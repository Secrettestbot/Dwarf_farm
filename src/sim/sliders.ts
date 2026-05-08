// Player priority sliders (GDD §4.1). Ten sliders, each in [0, 1] with
// 0.5 as the neutral default. Sliders don't issue commands — they bias
// the autonomous decision loop in chooseTask. A slider at 0 effectively
// disables a category for the colony; a slider at 1 makes that category
// preferred over equally available alternatives.
//
// Most sliders are wired to job kinds that don't exist yet (hauling,
// construction, crafting, military, research, medicine arrive in later
// sessions). They round-trip through save now so they're remembered when
// the relevant systems land.

export interface SliderState {
  /** Mining inside active blueprints. */
  excavation: number;
  /** Hauling items to stockpiles. Wired in Session 3. */
  hauling: number;
  /** Building rooms and furniture. Wired in Session 3. */
  construction: number;
  /** Workshop output (kitchen, brewery, smelter, forge). Wired in Session 3. */
  crafting: number;
  /** Farming and brewing — tending plots, eventually brewing barrels. */
  farming: number;
  /** Military training and squad readiness. Wired in Session 5. */
  military: number;
  /** Research at the library. Wired in Session 7. */
  research: number;
  /** Hospital staffing priority. Wired alongside hospitals in Session 5. */
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
