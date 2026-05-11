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
export type ResourceKind =
  | "food" | "drink" | "ore" | "stone" | "dirt" | "bars" | "tools"
  | "meals" | "gems" | "blocks" | "cut_gems" | "wood" | "planks" | "pots"
  | "hide" | "leather" | "rope" | "cloth"
  // Slice 1–7 furniture deliverables.
  | "bed" | "barrel" | "table" | "bin" | "stove" | "library_desk"
  | "throne" | "hospital_bed" | "tavern_counter" | "armoury_rack" | "pump_part"
  // Slice 8 workshop deliverables + trade depot + water wheel + farm.
  | "carpenter_bench" | "mason_bench"
  | "smelter_furnace" | "forge_anvil" | "magma_anvil"
  | "jeweller_bench" | "kiln_firebox" | "tannery_vat" | "loom_frame"
  | "trade_scales" | "water_wheel_axle" | "seed_bag";

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
    // One unit of food per brew (down from 2) and four units of drink
    // per brew (up from 3) — a brewer working steadily produces enough
    // for a small fortress without out-pacing the farms or piling up
    // entities. Tuned by the colony-survives-thirst integration test.
    inputKind: "food",
    inputQty: 1,
    outputKind: "drink",
    outputQty: 4,
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
  loom: {
    verb: "spins cloth",
    inputKind: "rope",
    inputQty: 1,
    outputKind: "cloth",
    outputQty: 1,
    ticks: 80,
    skill: "loom_tanning",
    station: TileType.LoomStation,
  },
  magma_forge: {
    // Magma Forge: same input/output as a regular Forge but the magma
    // heat lets the smith work substantially faster. Quality bonus is
    // wired separately in progressCraft (researchBias for forges).
    verb: "forges tools at the magma",
    inputKind: "bars",
    inputQty: 1,
    outputKind: "tools",
    outputQty: 1,
    ticks: 50, // vs 90 for a coal forge
    skill: "smithing",
    station: TileType.MagmaForgeStation,
  },
};

export function recipeFor(kind: BlueprintKind): Recipe | undefined {
  return RECIPES[kind];
}

/** Alternate carpenter recipe that produces a Bed item from planks.
 * progressCraft swaps the default `carpenter` recipe for this one
 * when a needs_furnishing bedroom is waiting AND the colony has
 * planks to spend — so the carpenter spends idle time milling logs
 * but switches to bed-building the moment beds are needed. */
export const CARPENTER_BED_RECIPE: Recipe = {
  verb: "builds a bed",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "bed",
  outputQty: 1,
  ticks: 90,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Alternate carpenter recipe that produces a Barrel item from planks.
 * Swapped in when a brewery is waiting on its barrel furniture
 * delivery. Same shape as the bed recipe — 2 planks, slow-ish build,
 * delivered as an item so the hauler can route it. */
export const CARPENTER_BARREL_RECIPE: Recipe = {
  verb: "builds a barrel",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "barrel",
  outputQty: 1,
  ticks: 90,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Alternate carpenter recipe for stockpile bins. Swapped in when a
 * stockpile is waiting on a bin delivery. */
export const CARPENTER_BIN_RECIPE: Recipe = {
  verb: "builds a storage bin",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "bin",
  outputQty: 1,
  ticks: 80,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Alternate mason recipe for dining-hall tables. Swapped in when a
 * dining hall is waiting on a table delivery. Stone blocks are
 * cheaper than other crafting inputs but the mason has to be
 * built first (Basic Stonecutting research). */
export const MASON_TABLE_RECIPE: Recipe = {
  verb: "carves a table",
  inputKind: "blocks",
  inputQty: 2,
  outputKind: "table",
  outputQty: 1,
  ticks: 100,
  skill: "masonry",
  station: TileType.MasonStation,
};

/** Alternate mason recipe for kitchen stoves. Two stone blocks
 * become a single carved hearth, slightly more involved than a
 * table (more ticks). */
export const MASON_STOVE_RECIPE: Recipe = {
  verb: "builds a stove",
  inputKind: "blocks",
  inputQty: 2,
  outputKind: "stove",
  outputQty: 1,
  ticks: 120,
  skill: "masonry",
  station: TileType.MasonStation,
};

/** Alternate carpenter recipe for library desks. Two planks make a
 * scholar's writing desk; the library needs one before research
 * can start. */
export const CARPENTER_LIBRARY_DESK_RECIPE: Recipe = {
  verb: "builds a writing desk",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "library_desk",
  outputQty: 1,
  ticks: 100,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Mason throne — a single grand carved chair for the throne room.
 * Four blocks reflects the king's centrepiece scale. */
export const MASON_THRONE_RECIPE: Recipe = {
  verb: "carves a throne",
  inputKind: "blocks",
  inputQty: 4,
  outputKind: "throne",
  outputQty: 1,
  ticks: 200,
  skill: "masonry",
  station: TileType.MasonStation,
};

/** Carpenter hospital cot — same materials as a bedroom bed but a
 * separate item so multiple cots can be tracked per hospital and
 * the recipe-swap priority can favour hospitals over morale. */
export const CARPENTER_HOSPITAL_BED_RECIPE: Recipe = {
  verb: "builds a hospital cot",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "hospital_bed",
  outputQty: 1,
  ticks: 100,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Carpenter tavern counter — bar for the tavern barkeep. */
export const CARPENTER_TAVERN_COUNTER_RECIPE: Recipe = {
  verb: "builds a tavern counter",
  inputKind: "planks",
  inputQty: 3,
  outputKind: "tavern_counter",
  outputQty: 1,
  ticks: 120,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Carpenter armoury rack — wooden frame to hang weapons on.
 * Soldier-drafting reads from the global tools counter, but the
 * rack tile is the visible marker that the colony has armed
 * itself. */
export const CARPENTER_ARMOURY_RACK_RECIPE: Recipe = {
  verb: "builds an armoury rack",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "armoury_rack",
  outputQty: 1,
  ticks: 90,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

/** Carpenter pump part — wooden pipework + treadle for the pump
 * station. The pump itself is non-functional until this lands. */
export const CARPENTER_PUMP_PART_RECIPE: Recipe = {
  verb: "builds a pump assembly",
  inputKind: "planks",
  inputQty: 3,
  outputKind: "pump_part",
  outputQty: 1,
  ticks: 130,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

// ---- Slice 8: workshop benches / anvils / mechanisms --------------------
// Each workshop needs a deliverable that gates its workstation tile.
// Mason recipes produce stone-heavy fixtures (anvils, furnaces, fireboxes,
// the carpenter's solid bench top); carpenter recipes produce the
// wood-frame benches and the items that don't need a stone forge.

export const MASON_CARPENTER_BENCH_RECIPE: Recipe = {
  verb: "carves a carpenter's bench",
  inputKind: "blocks",
  inputQty: 2,
  outputKind: "carpenter_bench",
  outputQty: 1,
  ticks: 110,
  skill: "masonry",
  station: TileType.MasonStation,
};

export const CARPENTER_MASON_BENCH_RECIPE: Recipe = {
  verb: "builds a mason's bench",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "mason_bench",
  outputQty: 1,
  ticks: 100,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

export const MASON_SMELTER_FURNACE_RECIPE: Recipe = {
  verb: "builds a smelter furnace",
  inputKind: "blocks",
  inputQty: 4,
  outputKind: "smelter_furnace",
  outputQty: 1,
  ticks: 180,
  skill: "masonry",
  station: TileType.MasonStation,
};

export const MASON_FORGE_ANVIL_RECIPE: Recipe = {
  verb: "carves a forge anvil",
  inputKind: "blocks",
  inputQty: 4,
  outputKind: "forge_anvil",
  outputQty: 1,
  ticks: 180,
  skill: "masonry",
  station: TileType.MasonStation,
};

export const MASON_MAGMA_ANVIL_RECIPE: Recipe = {
  verb: "carves a magma anvil",
  inputKind: "blocks",
  inputQty: 4,
  outputKind: "magma_anvil",
  outputQty: 1,
  ticks: 200,
  skill: "masonry",
  station: TileType.MasonStation,
};

export const CARPENTER_JEWELLER_BENCH_RECIPE: Recipe = {
  verb: "builds a jeweller's bench",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "jeweller_bench",
  outputQty: 1,
  ticks: 100,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

export const MASON_KILN_FIREBOX_RECIPE: Recipe = {
  verb: "builds a kiln firebox",
  inputKind: "blocks",
  inputQty: 3,
  outputKind: "kiln_firebox",
  outputQty: 1,
  ticks: 150,
  skill: "masonry",
  station: TileType.MasonStation,
};

export const CARPENTER_TANNERY_VAT_RECIPE: Recipe = {
  verb: "builds a tanning vat",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "tannery_vat",
  outputQty: 1,
  ticks: 100,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

export const CARPENTER_LOOM_FRAME_RECIPE: Recipe = {
  verb: "builds a loom frame",
  inputKind: "planks",
  inputQty: 2,
  outputKind: "loom_frame",
  outputQty: 1,
  ticks: 100,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

export const CARPENTER_TRADE_SCALES_RECIPE: Recipe = {
  verb: "builds trade scales",
  inputKind: "planks",
  inputQty: 3,
  outputKind: "trade_scales",
  outputQty: 1,
  ticks: 120,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};

export const CARPENTER_WATER_WHEEL_AXLE_RECIPE: Recipe = {
  verb: "builds a water-wheel axle",
  inputKind: "planks",
  inputQty: 4,
  outputKind: "water_wheel_axle",
  outputQty: 1,
  ticks: 160,
  skill: "carpentry",
  station: TileType.CarpenterStation,
};
