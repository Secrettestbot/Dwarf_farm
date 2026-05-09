// Workshop recipes — each workshop kind has a single recipe that consumes
// from the global stockpile and produces back into it. Item-routing
// (haulers deliver inputs into the workshop tile, output items appear on
// the workstation and get hauled out) lands later; for now the workshop
// pretends the colony's stockpile is its bench.
//
// The numbers are deliberately generous. A colony with one cook and a
// stocked larder should see meals climb steadily; a brewery should keep
// up with daily drink consumption; a smelter should produce enough bars
// that a future forge has something to forge.

import { BlueprintKind } from "./blueprint";
import { TileType } from "../world/tiles";
import { SkillId } from "../dwarves/skills";

/** Stockpile counters that recipes can read from / write to. Workshops
 * trade between the same fields the dwarves already eat / drink from
 * (food / drink / meals) plus accumulators (bars, tools) that future
 * production chains will consume. */
export type ResourceKind = "food" | "drink" | "ore" | "stone" | "dirt" | "bars" | "tools" | "meals" | "gems" | "blocks" | "cut_gems" | "wood" | "planks" | "pots" | "hide" | "leather";

export interface Recipe {
  /** Human-readable verb for the event log. */
  verb: string;
  inputKind: ResourceKind;
  inputQty: number;
  outputKind: ResourceKind;
  outputQty: number;
  /** Base ticks per craft. Skill above Novice scales this down. */
  ticks: number;
  /** Skill that grants speed bonus + XP. */
  skill: SkillId;
  /** Tile type that marks this workshop's workstation. The crafter must
   * stand on it for progressCraft to advance. */
  station: TileType;
}

export const RECIPES: Partial<Record<BlueprintKind, Recipe>> = {
  kitchen: {
    verb: "cooks meals",
    inputKind: "food",
    inputQty: 1,
    outputKind: "meals",
    outputQty: 2, // raw ingredients become twice as many cooked meals
    ticks: 60,
    skill: "cooking",
    station: TileType.KitchenStation,
  },
  brewery: {
    verb: "brews ale",
    inputKind: "food",
    inputQty: 2,
    outputKind: "drink",
    outputQty: 3,
    ticks: 60,
    skill: "brewing",
    station: TileType.BreweryStation,
  },
  smelter: {
    verb: "smelts bars",
    inputKind: "ore",
    inputQty: 1,
    outputKind: "bars",
    outputQty: 1,
    ticks: 90,
    skill: "smithing",
    station: TileType.SmelterStation,
  },
  forge: {
    verb: "forges tools",
    inputKind: "bars",
    inputQty: 1,
    outputKind: "tools",
    outputQty: 1,
    ticks: 90,
    skill: "smithing",
    station: TileType.ForgeStation,
  },
  mason: {
    verb: "cuts stone blocks",
    inputKind: "stone",
    inputQty: 1,
    outputKind: "blocks",
    outputQty: 2, // a single rough stone yields two square blocks
    ticks: 70,
    skill: "masonry",
    station: TileType.MasonStation,
  },
  jeweller: {
    verb: "cuts gems",
    inputKind: "gems",
    inputQty: 1,
    outputKind: "cut_gems",
    outputQty: 1,
    ticks: 110,
    skill: "jewelling",
    station: TileType.JewellerStation,
  },
  carpenter: {
    verb: "saws planks",
    inputKind: "wood",
    inputQty: 1,
    outputKind: "planks",
    outputQty: 2, // a single log saws into two planks
    ticks: 70,
    skill: "carpentry",
    station: TileType.CarpenterStation,
  },
  kiln: {
    verb: "fires pottery",
    inputKind: "dirt",
    inputQty: 2, // wedge two scoops of clay-rich earth into a single pot
    outputKind: "pots",
    outputQty: 1,
    ticks: 100,
    skill: "masonry",
    station: TileType.KilnStation,
  },
  tannery: {
    verb: "tans leather",
    inputKind: "hide",
    inputQty: 1,
    outputKind: "leather",
    outputQty: 1,
    ticks: 90,
    skill: "loom_tanning",
    station: TileType.TannerStation,
  },
};

export function recipeFor(kind: BlueprintKind): Recipe | undefined {
  return RECIPES[kind];
}
