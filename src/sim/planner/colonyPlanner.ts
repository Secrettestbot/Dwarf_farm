// The Colony Planner is the colony's collective intention. It periodically
// asks "what does the colony need next?" and, when a need crosses a threshold,
// emits a Blueprint — a specific cavity at a specific location with a specific
// purpose. Dwarves consult the planner via chooseTask: they only mine inside
// active blueprints.
//
// v3 (this session) adds the colony's exploration urge:
//   - Corridor blueprints: 1-tile-wide tunnels extending outward into solid
//     rock, preferring downward, then lateral, then upward. They exist to
//     extend the colony's walkable reach so future room/mine blueprints have
//     somewhere new to land.
//   - Mine blueprints: 3×3 cavities centered on Ore tiles within sensing
//     range of walkable space. The colony harvests minerals by following ore
//     veins as soon as a corridor exposes them.
//   - Periodic corridor emission: every two completed rooms, the planner
//     wants another corridor so the colony keeps growing outward instead of
//     sealing itself into a tight cluster around spawn.
//
// Future sessions add the geology signal proper (sense ore vein density to
// steer corridor direction), the Architect dwarf signal (style preferences
// per leader), and stairwells as a distinct kind for descending floors.

import { TileGrid } from "../world/grid";
import { TileType, tileIsGem } from "../world/tiles";
import { Rng } from "../rng";
import { EventLog } from "../events/eventLog";
import { narrateBlueprintBegin, narrateBlueprintComplete } from "../events/narrator";
import { Blueprint, BlueprintKind, BLUEPRINT_KIND_LABELS, FURNITURE_REQUIREMENTS, isComplete, isRoomNeglected, rectCavity, QUALITY_BASE } from "./blueprint";
import { furnishRoom, prepareInfrastructureForFurnishing } from "./furnish";

export interface PlannerContext {
  grid: TileGrid;
  spawn: { x: number; y: number };
  tick: number;
  /** Live colony population — drives how aggressively the planner expands. */
  population: number;
  /** Forked, deterministic RNG used to vary placement (corridor length,
   * width, direction sampling). State is part of SimWorld and serialized. */
  rng: Rng;
  /** Optional event log — when present, the planner narrates blueprint
   * lifecycle events ("plans laid out", "tunnel complete", etc.). The log
   * is part of save state, so the chronicle is reproducible. */
  events?: EventLog;
  /** Research progress. Gates the workshops whose recipes require
   * research per GDD §10.2 (Smelter on Iron Smelting, Forge on Iron
   * Toolmaking). When absent, the planner assumes nothing is researched
   * yet — useful for unit tests of the planner in isolation. */
  research?: { completed: string[] };
  /** True iff the colony has breached an aquifer at some point. Gates
   * the Pump Station emission — building one before there's water to
   * pump would be a waste of dwarf-hours. */
  aquiferBreached?: boolean;
  /** Recent stockpile-bound hauls that took longer than FAR_HAUL_TICKS.
   * Drives the secondary needsStockpile signal: a queue of slow
   * deliveries means another stockpile near the pickup region would
   * pay for itself. Optional so isolated planner tests don't need
   * to stub it out. */
  recentFarHauls?: Array<{ x: number; y: number; tick: number }>;
  /** Number of loose, hauler-bound items currently lying on the
   * floor. Used to gate *exploration* emissions (corridor / stairwell
   * / lumberyard) — when the colony is buried in unhauled stones and
   * food, opening more mining work would steal dwarves from the
   * hauling they need to be doing. Optional for the same reason
   * recentFarHauls is. */
  looseItemCount?: number;
  /** Set of item kinds with at least one loose entity in the world.
   * The architect consults this to decide whether a room with a
   * furniture requirement can actually be furnished from existing
   * supply — without it, a room would block on "carpenter must be
   * complete" even when a founder-kit bed is sitting at spawn ready
   * to deliver. Optional; older callers pass undefined and the
   * gate falls back to producer-complete only. */
  availableFurniture?: Set<string>;
}

const PLAN_INTERVAL_TICKS = 60; // re-evaluate once per in-game hour

/** Producer workshop required to furnish each room kind — the
 * carpenter ships beds / barrels / bins / library_desks / etc.; the
 * mason ships tables / stoves / thrones / smelter / forge / kiln
 * / magma anvils. The architect uses this map to refuse emitting a
 * room whose furniture chain isn't operational yet, so a bedroom
 * doesn't sit in needs_furnishing for hundreds of ticks waiting on
 * a carpenter that doesn't exist. Rooms with no entry don't have a
 * producer gate: the carpenter / mason themselves bootstrap from the
 * founder kit (and each other), and farms get their seed bag from
 * the founder kit / other farms / caravan trade rather than any
 * workshop recipe. */
const ROOM_PRODUCER: Partial<Record<BlueprintKind, BlueprintKind>> = {
  bedroom: "carpenter",
  brewery: "carpenter",
  stockpile: "carpenter",
  library: "carpenter",
  hospital: "carpenter",
  tavern: "carpenter",
  armoury: "carpenter",
  pump_station: "carpenter",
  jeweller: "carpenter",
  tannery: "carpenter",
  loom: "carpenter",
  trade_depot: "carpenter",
  water_wheel: "carpenter",
  dining_hall: "mason",
  kitchen: "mason",
  throne_room: "mason",
  smelter: "mason",
  forge: "mason",
  magma_forge: "mason",
  kiln: "mason",
};

/** Far-haul log entries older than this lose their vote in
 * needsStockpile — haul patterns shift fast as workshops come
 * online and the architect shouldn't act on a stale signal. */
const FAR_HAUL_AGE_TICKS_FOR_DEMAND = 24 * 60; // one in-game day

/** Needs-furnishing rooms older than this stop counting toward
 * the architect's backlog throttle. A stuck room (haulers unable
 * to reach the cavity, no surviving crafter for its requirement,
 * etc.) isn't a "haulers are busy" signal — pausing the architect
 * indefinitely doesn't unstick it. */
const FURNISHING_BACKLOG_AGE_TICKS = 24 * 60; // one in-game day

const ROOM_DIMS: Record<BlueprintKind, { w: number; h: number; priority: number }> = {
  bedroom: { w: 4, h: 3, priority: 1 },
  dining_hall: { w: 8, h: 5, priority: 3 },
  stockpile: { w: 5, h: 4, priority: 2 },
  // Corridors are placed by a custom routine; this dim entry just holds the
  // per-segment metadata used by the renderer / blueprint commit path.
  corridor: { w: 8, h: 1, priority: 4 },
  // Mines are 2×2 chambers around an ore tile. Smaller than rooms so they
  // can fit between corridors and ore-vein neighbours where larger cavities
  // would be blocked by adjacent walkable tiles.
  mine: { w: 2, h: 2, priority: 2 },
  farm: { w: 4, h: 3, priority: 2 },
  stairwell: { w: 2, h: 6, priority: 5 },
  // Workshops: a small chamber with the workstation in its centre. Big
  // enough that a hauler can squeeze past the crafter, small enough not
  // to bloat the architect's footprint when several workshops drop in.
  kitchen: { w: 3, h: 3, priority: 2 },
  brewery: { w: 3, h: 3, priority: 2 },
  smelter: { w: 3, h: 3, priority: 2 },
  forge: { w: 3, h: 3, priority: 2 },
  // Trade depot: a wider open room near the entrance for caravans to
  // park. Placed once per colony at moderate size.
  trade_depot: { w: 5, h: 4, priority: 3 },
  // Library: a quiet 4×3 chamber with two desks. Wider than the
  // workshops so two scholars can fit without colliding.
  library: { w: 4, h: 3, priority: 2 },
  // Armoury: a 4×3 room with rack tiles along the back wall. Stores
  // tools the smiths produced; the draft system equips soldiers from
  // the global tools counter when this room exists.
  armoury: { w: 4, h: 3, priority: 2 },
  // Throne Room: 5×4 ceremonial space with a single throne tile. The
  // colony only earns this once it has the surplus to spare on
  // ornament — gated on population in the architect.
  throne_room: { w: 5, h: 4, priority: 1 },
  // Pump Station: a 3×3 chamber with a single pump tile. Reclaims
  // flooded corridors after an aquifer breach; gated on the Tier 2
  // Hydraulic Basics topic + a breach having actually happened.
  pump_station: { w: 3, h: 3, priority: 2 },
  // Mason's Workshop: 3×3 with a bench in the centre. Gated on the
  // Tier 1 Basic Stonecutting topic — the colony has to know how
  // before it cuts stone.
  mason: { w: 3, h: 3, priority: 2 },
  // Jeweller's Workshop: 3×3. Tier 3 Gem Cutting + at least one gem
  // discovered before the architect bothers laying it out.
  jeweller: { w: 3, h: 3, priority: 2 },
  // Carpenter's Workshop: 3×3 with a bench in the centre. Gated on the
  // Tier 1 Basic Carpentry research; needs surface trees to feed it.
  carpenter: { w: 3, h: 3, priority: 2 },
  // Lumberyard: a single-tile commitment to chop one surface tree.
  // Width/height get adjusted to 1×1 in placeLumberyard; the entry here
  // is just for table completeness.
  lumberyard: { w: 1, h: 1, priority: 3 },
  // Kiln: 3×3 with a fire pit in the centre. Tier 2 Pottery & Kilns
  // gates it; cheap-to-build but the recipe is slow.
  kiln: { w: 3, h: 3, priority: 2 },
  // Tannery: 3×3 workshop. Tier 2 Textile Craft gates it.
  tannery: { w: 3, h: 3, priority: 2 },
  // Loom: 3×3 workshop. Tier 1 Rope & Fibre gates it; rope accumulates
  // off the colony's farm cells, cloth comes back out.
  loom: { w: 3, h: 3, priority: 2 },
  // Hospital: 4×3 ward with two cots. Tier 2 Medical Practice gates it;
  // wounded dwarves heal substantially faster on the cots and the
  // colony's medic earns medicine XP every tick a wound is tended.
  hospital: { w: 4, h: 3, priority: 2 },
  // Tavern: 5×4 social hall. The colony's morale-recovery space.
  tavern: { w: 5, h: 4, priority: 2 },
  // Magma Forge: 3×3 workshop. Tier 4 Magma Forge Craft + a Magma
  // Vent reachable from the colony.
  magma_forge: { w: 3, h: 3, priority: 1 },
  // Water Wheel: 2×2 mechanism placed adjacent to Water tiles. No
  // recipe, just a passive speed bonus to nearby workshops.
  water_wheel: { w: 2, h: 2, priority: 3 },
  // Cemetery: 5×5 plot of grave-floor tiles. Buried dwarves get a
  // headstone slotted into one of the empty plots; the chronicle
  // records who lies under each.
  cemetery: { w: 5, h: 5, priority: 2 },
};

const CORRIDOR_MIN_LEN = 4;
const CORRIDOR_MAX_LEN = 10;
const ORE_SENSE_RADIUS = 12; // an ore tile is sense-able this many tiles from walkable
/** Minimum thickness of solid rock above a room's ceiling. A bedroom
 * carved one tile under the surface looks ridiculous and offers no
 * protection from anything that comes down from above. Two tiles is
 * a sturdy ceiling — caves, sieges, and weather all stop there. */
const ROOM_CEILING_BUFFER = 2;
/** Geology signal — when the planner places a corridor, it counts
 * ore + gem tiles in solid rock within this radius of the corridor's
 * exit point, and adds a bonus to the candidate's score. The colony
 * thus tends to dig outward toward what its dwarves can faintly
 * sense ahead, even before a tunnel exposes it. The radius is wider
 * than ORE_SENSE_RADIUS because the planner's "rumour" radius
 * extends beyond what an actual mining target needs. */
const GEOLOGY_SCAN_RADIUS = 18;
/** Score multiplier per sensed mineral tile within the scan radius.
 * Tuned so a corridor heading into a dense vein can outweigh the
 * default downward depth bias only by a modest margin — the colony
 * still wants to descend overall, but it will deviate sideways for
 * a worthwhile vein. */
const GEOLOGY_PER_TILE_BONUS = 6;
/** One architect per ARCHITECT_PER_DWARVES dwarves: a small colony of seven
 * gets one active blueprint at a time, but a larger colony parallelises the
 * work and expands faster. */
const ARCHITECT_PER_DWARVES = 7;

interface StylePref {
  bedroom: number;
  dining_hall: number;
  stockpile: number;
}

const DEFAULT_STYLE: StylePref = {
  bedroom: 0,
  dining_hall: -1,
  stockpile: +1,
};

// Direction preferences for corridor placement. Higher pref = more attractive.
// Downward is most-preferred so the colony sinks into the mountain.
interface CorridorDir {
  dx: number;
  dy: number;
  pref: number;
}
const CORRIDOR_DIRS: CorridorDir[] = [
  { dx: 0, dy: 1, pref: 100 },   // down
  { dx: 1, dy: 0, pref: 60 },    // right
  { dx: -1, dy: 0, pref: 60 },   // left
  { dx: 0, dy: -1, pref: -120 }, // up — strongly disfavored
];

const REACH_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** Count Water tiles within `radius` of (cx, cy). Used by the
 * pump-station placement bias so the planner picks a spot that
 * actually has water to drain rather than landing the pump room
 * across the colony from the breach. */
function countWaterNear(grid: TileGrid, cx: number, cy: number, radius: number): number {
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      if (grid.getTile(cx + dx, cy + dy) === TileType.Water) n++;
    }
  }
  return n;
}

/** Perpendicular direction vector used to widen 2-wide corridors. */
function perpendicularOf(dx: number, dy: number): { dx: number; dy: number } {
  // Rotate 90° clockwise. For vertical corridors this gives a perpendicular
  // along the x-axis; for horizontal, along the y-axis.
  return { dx: -dy, dy: dx };
}

export class ColonyPlanner {
  blueprints: Blueprint[] = [];
  nextId = 1;
  private accum = 0;
  completed = 0;

  completedByKind: Record<string, number> = {};
  private claimedBy: Int32Array | null = null;
  private claimedW = 0;

  // Reachable-from-spawn mask. The planner only emits blueprints whose
  // cavity is adjacent to a walkable tile reachable from spawn — otherwise
  // dwarves end up with blueprints in disconnected caverns they can't path
  // to. Recomputed lazily when walkable space changes.
  private reachable: Uint8Array | null = null;
  private reachableW = 0;
  private reachableDirty = true;

  /** Run one planning step. Called from sim.tick BEFORE job assignment. */
  tick(ctx: PlannerContext): void {
    this.accum++;
    this.harvestCompleted(ctx);

    if (this.accum < PLAN_INTERVAL_TICKS) return;
    this.accum = 0;

    // Architect count scales with population: 1 architect per 7 dwarves,
    // minimum 1. As the colony grows, more parallel blueprints can be
    // active, so growth speeds up.
    const architects = Math.max(1, Math.ceil(ctx.population / ARCHITECT_PER_DWARVES));
    // Furnishing backlog gate. When the queue of cavities waiting on
    // a hauler genuinely outstrips what the colony can clear, the
    // architect stops opening new sites — opening room twenty while
    // rooms one through nineteen still wait for furniture just
    // wastes mining XP and clutters the map. The limit is set high
    // (≈ 1.5 outstanding rooms per dwarf, floor 12) so the early-
    // game bootstrap (founder colony with workshop benches sitting
    // at spawn waiting for delivery while haulers chase the first
    // farm yield) still completes — the throttle is meant to catch
    // late-game runaway expansion, not slow the initial buildout.
    const backlogLimit = Math.max(12, Math.ceil(ctx.population * 1.5));
    if (this.furnishingBacklog(ctx.tick) > backlogLimit) return;
    while (this.activeCount() < architects) {
      if (!this.tryPlaceNext(ctx)) break;
    }
  }

  /**
   * Try to emit one new blueprint, in priority order. Returns true if a
   * blueprint was placed; false if nothing fit. The dispatch logic interleaves
   * infrastructure (rooms) with exploration (corridors, mines) so the colony
   * keeps growing outward instead of stalling once the spawn cavern is full.
   */
  private tryPlaceNext(ctx: PlannerContext): boolean {
    const active = this.activeByKind();

    // 1. Mine — if ore is sensed and reachable, harvest it. High priority so
    //    the colony pursues minerals as soon as a corridor exposes them.
    if ((active["mine"] ?? 0) === 0 && this.placeMine(ctx)) return true;

    // 2. Dining hall and stockpile — emit once at population thresholds.
    //    Each room emission is gated on producerReady: the workshop
    //    that ships the room's furniture must be operational, or an
    //    item of the right kind must already exist in the world.
    //    Without this gate the architect would open a dining hall
    //    before the mason can carve a table, leaving the room
    //    parked in needs_furnishing indefinitely.
    if (this.needsDiningHall(ctx) && this.producerReady("dining_hall", ctx) && this.placeRoom(ctx, "dining_hall")) return true;
    if (this.needsStockpile(ctx) && this.producerReady("stockpile", ctx) && this.placeRoom(ctx, "stockpile")) return true;
    if (this.needsFarm(ctx) && this.placeRoom(ctx, "farm")) return true;
    if (this.needsPumpStation(ctx) && this.producerReady("pump_station", ctx) && this.placeRoom(ctx, "pump_station")) return true;
    if (this.needsKitchen(ctx) && this.producerReady("kitchen", ctx) && this.placeRoom(ctx, "kitchen")) return true;
    if (this.needsBrewery(ctx) && this.producerReady("brewery", ctx) && this.placeRoom(ctx, "brewery")) return true;
    if (this.needsSmelter(ctx) && this.producerReady("smelter", ctx) && this.placeRoom(ctx, "smelter")) return true;
    if (this.needsForge(ctx) && this.producerReady("forge", ctx) && this.placeRoom(ctx, "forge")) return true;
    if (this.needsTradeDepot(ctx) && this.producerReady("trade_depot", ctx) && this.placeRoom(ctx, "trade_depot")) return true;
    if (this.needsLibrary(ctx) && this.producerReady("library", ctx) && this.placeRoom(ctx, "library")) return true;
    if (this.needsArmoury(ctx) && this.producerReady("armoury", ctx) && this.placeRoom(ctx, "armoury")) return true;
    if (this.needsThroneRoom(ctx) && this.producerReady("throne_room", ctx) && this.placeRoom(ctx, "throne_room")) return true;
    if (this.needsMason(ctx) && this.placeRoom(ctx, "mason")) return true;
    if (this.needsJeweller(ctx) && this.producerReady("jeweller", ctx) && this.placeRoom(ctx, "jeweller")) return true;
    if (this.needsCarpenter(ctx) && this.placeRoom(ctx, "carpenter")) return true;
    if (this.needsKiln(ctx) && this.producerReady("kiln", ctx) && this.placeRoom(ctx, "kiln")) return true;
    if (this.needsTannery(ctx) && this.producerReady("tannery", ctx) && this.placeRoom(ctx, "tannery")) return true;
    if (this.needsLoom(ctx) && this.producerReady("loom", ctx) && this.placeRoom(ctx, "loom")) return true;
    if (this.needsHospital(ctx) && this.producerReady("hospital", ctx) && this.placeRoom(ctx, "hospital")) return true;
    if (this.needsTavern(ctx) && this.producerReady("tavern", ctx) && this.placeRoom(ctx, "tavern")) return true;
    if (this.needsMagmaForge(ctx) && this.producerReady("magma_forge", ctx) && this.placeRoom(ctx, "magma_forge")) return true;
    if (this.needsWaterWheel(ctx) && this.producerReady("water_wheel", ctx) && this.placeRoom(ctx, "water_wheel")) return true;
    if (this.needsCemetery(ctx) && this.placeRoom(ctx, "cemetery")) return true;

    // Exploration corridors pause when the colony is buried in
    // unhauled loose items. Threshold scales with population —
    // a 20-dwarf colony tolerates ~200 stones / food / etc. on
    // the floor before the gate fires (normal steady-state with 3
    // farms producing food on cells routinely sits around 100).
    // Only corridors are gated — stairwells (vertical descent) and
    // lumberyards (single-tile, harvest wood) are cheap, infrequent
    // emissions and disabling them would block colony progress more
    // than the gate is worth.
    const haulSaturated = (ctx.looseItemCount ?? 0) > Math.max(200, ctx.population * 10);

    // 2.8 Lumberyard — chop a surface tree any time one is sense-able
    //     and there's no active lumberyard yet. Cheap, single-tile
    //     blueprints, so the colony harvests wood as the architect
    //     spots it. Gated only on having a Carpenter's Workshop or
    //     basic carpentry research — without somewhere to use the wood,
    //     felling trees is just clearing.
    if ((active["lumberyard"] ?? 0) === 0 && this.wantsLumberyard(ctx) && this.placeLumberyard(ctx)) return true;

    // 2.9 Stairwell — every few completed rooms the architect drops a
    //     vertical 2×6 shaft so the colony actually descends instead of
    //     spreading sideways. Without this, dwarves dig wide but
    //     shallow and the Gem Seam stays out of reach.
    if (this.wantsStairwell() && this.placeRoom(ctx, "stairwell")) return true;

    // 3. Periodic corridor — every two completed rooms the colony wants
    //    another corridor segment so its reach keeps growing. This is what
    //    turns "a cluster of rooms around spawn" into "a network of tunnels".
    if (!haulSaturated && this.wantsExplorationCorridor() && this.placeCorridor(ctx)) return true;

    // 4. Bedrooms — fill up to population target.
    if (this.needsBedroom(ctx) && this.producerReady("bedroom", ctx) && this.placeRoom(ctx, "bedroom")) return true;

    // 5. Fallback corridor — when nothing else fit, dig outward. Critical:
    //    without this the planner stops cold once the immediate neighborhood
    //    is full of rooms, and the dwarves go idle. Still gated on
    //    haul saturation: dwarves digging into rock can wait while the
    //    colony empties its backlog of stones.
    if (!haulSaturated && (active["corridor"] ?? 0) === 0 && this.placeCorridor(ctx)) return true;

    return false;
  }

  // ---- Dispatch predicates -----------------------------------------------

  private needsDiningHall(ctx: PlannerContext): boolean {
    if (ctx.population < 4) return false;
    return this.existingByKind("dining_hall") === 0;
  }

  private needsStockpile(ctx: PlannerContext): boolean {
    if (ctx.population < 5) return false;
    const existing = this.existingByKind("stockpile");
    // First stockpile lands as soon as the colony's big enough to
    // have somewhere to put items. After that, the signal is haul
    // travel time: when the planner sees enough recently-delivered
    // hauls that took longer than FAR_HAUL_TICKS, the colony's
    // running out of nearby drop capacity and another stockpile
    // pays for itself by halving the next hauler's round-trip.
    if (existing === 0) return true;
    // Soft cap so a sprawling endgame fortress doesn't carpet
    // itself in stockpiles: roughly one per eight dwarves.
    const cap = Math.max(1, Math.ceil(ctx.population / 8));
    if (existing >= cap) return false;
    // Age out old far-haul entries before counting — a haul pattern
    // from yesterday isn't relevant if the colony has reshuffled
    // since. The threshold (8) is a quorum: needs sustained signal
    // across several deliveries, not just one slow trip.
    const cutoff = ctx.tick - FAR_HAUL_AGE_TICKS_FOR_DEMAND;
    let fresh = 0;
    for (const e of ctx.recentFarHauls ?? []) if (e.tick >= cutoff) fresh++;
    return fresh >= 8;
  }

  private needsFarm(ctx: PlannerContext): boolean {
    // First farm at pop ≥ 4; one additional farm per ~7 dwarves. Keeps
    // the colony fed through migration-driven growth.
    if (ctx.population < 4) return false;
    const target = Math.max(1, Math.ceil(ctx.population / 7));
    return this.maintainedAndActiveOfKind("farm", ctx.tick) < target;
  }

  private needsBedroom(ctx: PlannerContext): boolean {
    const target = Math.max(2, Math.ceil(Math.max(1, ctx.population) * 1.5));
    // Only well-maintained bedrooms count toward the target. A neglected
    // bedroom has to be brought back into shape before the architect
    // emits another one — capping the colony's footprint at what its
    // dwarves can actually keep up with.
    return this.maintainedAndActiveOfKind("bedroom", ctx.tick) < target;
  }

  private needsKitchen(ctx: PlannerContext): boolean {
    // Tier 1 Basic Cooking gates the Kitchen — the colony has to know
    // how to cook before the architect lays out a kitchen. Founders'
    // starter cache feeds them through the early research window.
    // Scales with population (one kitchen per ~10 dwarves) so meal
    // production keeps up with a post-migration colony.
    if (ctx.population < 5) return false;
    if (!(ctx.research?.completed ?? []).includes("basic_cooking")) return false;
    const target = Math.max(1, Math.ceil(ctx.population / 10));
    // Use completedByKind so neglect doesn't trigger an emission
    // cascade — same reasoning as the brewery scaling.
    const built = (this.completedByKind["kitchen"] ?? 0) + (this.activeByKind()["kitchen"] ?? 0);
    return built < target;
  }

  private needsBrewery(ctx: PlannerContext): boolean {
    // Tier 1 Basic Brewing gates the Brewery. Same reasoning as the
    // kitchen — the founders' cellar lasts until research lands.
    // One brewery per ~8 dwarves. Use completedByKind (total
    // completed) rather than maintainedAndActiveOfKind so a
    // neglected brewery doesn't trigger an emission cascade — the
    // colony was building 20+ breweries and starving its farms
    // dry once neglect-driven emissions added up over the long run.
    if (ctx.population < 5) return false;
    if (!(ctx.research?.completed ?? []).includes("basic_brewing")) return false;
    // One brewery per ~14 dwarves. A 4-drink-per-brew brewery
    // running steadily covers ~120 dwarves of demand, so the cap
    // mostly exists to add a second brewery when one isn't enough
    // to outpace consumption (the brewers themselves aren't always
    // at the station — they get pulled to eat, sleep, etc.).
    // Earlier ratios (1 per 7-8) were over-aggressive: many
    // breweries × 1 food/brew × 24 brews/day drained food before
    // farms could keep up.
    const target = Math.max(1, Math.ceil(ctx.population / 14));
    const built = (this.completedByKind["brewery"] ?? 0) + (this.activeByKind()["brewery"] ?? 0);
    return built < target;
  }

  private needsSmelter(ctx: PlannerContext): boolean {
    // The smelter only matters once there's actually ore to smelt and a
    // population large enough to spare a dedicated smith. Gated on the
    // Tier 1 Iron Smelting topic per GDD §10.2 — without research,
    // ore stays raw.
    if (ctx.population < 8) return false;
    if (!(ctx.research?.completed ?? []).includes("iron_smelting")) return false;
    return this.existingByKind("smelter") === 0;
  }

  private needsForge(ctx: PlannerContext): boolean {
    // The forge needs the smelter to feed it; gate one tier above. Also
    // gates on Iron Toolmaking research (Tier 1) so a colony has to
    // know how before it builds a forge.
    if (ctx.population < 10) return false;
    if (!(ctx.research?.completed ?? []).includes("iron_toolmaking")) return false;
    if (this.existingByKind("smelter") === 0) return false;
    return this.existingByKind("forge") === 0;
  }

  private needsTradeDepot(ctx: PlannerContext): boolean {
    // Caravans only show up once the colony is large enough to be worth
    // visiting — and only one depot per fortress.
    if (ctx.population < 6) return false;
    return this.existingByKind("trade_depot") === 0;
  }

  private needsLibrary(ctx: PlannerContext): boolean {
    // The library lands once the colony has the bandwidth to spare a
    // dwarf or two for scholarship. Lowered to pop ≥ 5 so research can
    // run before the smelter / forge tier — those are now gated on
    // research topics. Use completedByKind so a neglected library
    // doesn't trigger an emission cascade (the colony was building
    // 5+ libraries over a long run, tying up too many scholars).
    if (ctx.population < 5) return false;
    const built = (this.completedByKind["library"] ?? 0) + (this.activeByKind()["library"] ?? 0);
    return built === 0;
  }

  private needsArmoury(ctx: PlannerContext): boolean {
    // Once the colony has researched Armoury Basics (Tier 2) and is
    // big enough to need a standing guard, drop an armoury so the
    // soldiers' tools have somewhere to live. One per fortress.
    if (ctx.population < 7) return false;
    if (!(ctx.research?.completed ?? []).includes("armoury_basics")) return false;
    return this.existingByKind("armoury") === 0;
  }

  private needsThroneRoom(ctx: PlannerContext): boolean {
    // The throne room is the GDD's "Grand Citadel" milestone target —
    // a fortress reaches it once it has the surplus to spare. Gated on
    // a real population (so a five-dwarf colony doesn't cosplay royalty)
    // and on Masonry & Mortaring (Tier 2) — the masons need to know
    // how to lay a proper hall. One per fortress.
    if (ctx.population < 30) return false;
    if (!(ctx.research?.completed ?? []).includes("masonry_and_mortaring")) return false;
    return this.existingByKind("throne_room") === 0;
  }

  private needsPumpStation(ctx: PlannerContext): boolean {
    // GDD §10.2 Tier 2 Hydraulic Basics gates the pump room. The
    // architect waits until an aquifer has actually been breached
    // before laying one out — an empty pump room with no water to
    // pump is just a dwarf labor sink.
    if (ctx.population < 5) return false;
    if (!ctx.aquiferBreached) return false;
    if (!(ctx.research?.completed ?? []).includes("hydraulic_basics")) return false;
    return this.existingByKind("pump_station") === 0;
  }

  private needsMason(ctx: PlannerContext): boolean {
    // Mason's Workshop is gated on Basic Stonecutting (Tier 1) — the
    // first masonry topic the scholars will research. Once they have
    // it, the architect lays out a workshop so the colony can start
    // turning rough stone into blocks.
    if (ctx.population < 6) return false;
    if (!(ctx.research?.completed ?? []).includes("basic_stonecutting")) return false;
    return this.existingByKind("mason") === 0;
  }

  private needsJeweller(ctx: PlannerContext): boolean {
    // Tier 3 Gem Cutting gates the Jeweller. Plus the colony has to
    // have seen at least one gem — laying out a Jeweller's Workshop
    // before any gems exist would be ornament for ornament's sake.
    if (ctx.population < 10) return false;
    if (!(ctx.research?.completed ?? []).includes("gem_cutting")) return false;
    return this.existingByKind("jeweller") === 0;
  }

  private needsCarpenter(ctx: PlannerContext): boolean {
    // Carpenter's Workshop is gated on Tier 1 Basic Carpentry. Pop ≥ 6
    // mirrors the Mason gate — the colony needs the bandwidth to spare
    // a sawyer.
    if (ctx.population < 6) return false;
    if (!(ctx.research?.completed ?? []).includes("basic_carpentry")) return false;
    return this.existingByKind("carpenter") === 0;
  }

  private needsKiln(ctx: PlannerContext): boolean {
    // Kiln is gated on Tier 2 Pottery & Kilns. Pop ≥ 8 — pottery sits
    // a notch above the basic stone/wood crafts, so the architect waits
    // until the colony's a bit larger before laying one out.
    if (ctx.population < 8) return false;
    if (!(ctx.research?.completed ?? []).includes("pottery_and_kilns")) return false;
    return this.existingByKind("kiln") === 0;
  }

  private needsTannery(ctx: PlannerContext): boolean {
    // Tannery sits behind Tier 2 Textile Craft — same topic that
    // unlocks the future Loom for cloth. Pop ≥ 8 mirrors the kiln.
    if (ctx.population < 8) return false;
    if (!(ctx.research?.completed ?? []).includes("textile_craft")) return false;
    return this.existingByKind("tannery") === 0;
  }

  private needsLoom(ctx: PlannerContext): boolean {
    // Loom sits behind Tier 1 Rope & Fibre. Pop ≥ 6 — it's a small
    // craft, not a heavy industry, so a mid-sized colony can afford
    // a weaver.
    if (ctx.population < 6) return false;
    if (!(ctx.research?.completed ?? []).includes("rope_and_fibre")) return false;
    return this.existingByKind("loom") === 0;
  }

  private needsHospital(ctx: PlannerContext): boolean {
    // Hospital lands once Tier 2 Medical Practice is researched and the
    // colony's large enough to spare a medic.
    if (ctx.population < 10) return false;
    if (!(ctx.research?.completed ?? []).includes("medical_practice")) return false;
    return this.existingByKind("hospital") === 0;
  }

  private needsTavern(ctx: PlannerContext): boolean {
    // Tavern: a social space. No research gate — the architect drops one
    // once the colony's big enough to want a centralised hangout.
    if (ctx.population < 8) return false;
    return this.existingByKind("tavern") === 0;
  }

  private needsMagmaForge(ctx: PlannerContext): boolean {
    // Magma Forge: Tier 4 magma_forge_craft research, plus a Magma
    // Vent has to be sense-able from the colony's reachable space.
    // Pop ≥ 12 — the late-game industrial commitment.
    if (ctx.population < 12) return false;
    if (!(ctx.research?.completed ?? []).includes("magma_forge_craft")) return false;
    if (!this.hasReachableTileOfKind(ctx, TileType.MagmaVent, 6)) return false;
    return this.existingByKind("magma_forge") === 0;
  }

  /** True iff any tile of `kind` exists within `radius` of a
   * reachable walkable tile. Used by the magma forge / water wheel
   * gates to confirm the colony actually has the resource the
   * architect wants to build for. */
  private hasReachableTileOfKind(ctx: PlannerContext, kind: TileType, radius: number): boolean {
    const grid = ctx.grid;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.getTile(x, y) !== kind) continue;
        if (this.tileNearReachable(ctx, x, y, radius)) return true;
      }
    }
    return false;
  }

  private needsWaterWheel(ctx: PlannerContext): boolean {
    // Water Wheel: Tier 2 carpentry_mechanisms research + a Water
    // tile reachable from the colony (typically post-aquifer breach
    // or a controlled-flood corridor).
    if (ctx.population < 8) return false;
    if (!(ctx.research?.completed ?? []).includes("carpentry_mechanisms")) return false;
    if (!this.hasReachableTileOfKind(ctx, TileType.Water, 4)) return false;
    return this.existingByKind("water_wheel") === 0;
  }

  private needsCemetery(ctx: PlannerContext): boolean {
    // Cemetery: lands once the colony's stable enough to set ground
    // aside for the dead. Pop ≥ 6 — small enough to land before the
    // first old-age deaths, large enough that a one-dwarf founder
    // colony isn't carving graves first thing. No research gate.
    if (ctx.population < 6) return false;
    return this.existingByKind("cemetery") === 0;
  }

  /** Lumberyards land any time a tree is reachable from the colony's
   * walkable space. We don't gate on research — chopping wood is just
   * labour — but if the colony has neither a Carpenter's Workshop nor
   * the research to build one, suppress new lumberyards so wood
   * doesn't pile up uselessly. */
  private wantsLumberyard(ctx: PlannerContext): boolean {
    const hasCarpenter = this.existingByKind("carpenter") > 0;
    const willBuildOne = (ctx.research?.completed ?? []).includes("basic_carpentry");
    return hasCarpenter || willBuildOne;
  }

  /**
   * Count of completed rooms of `kind` that are not currently neglected,
   * plus any blueprint of that kind still being dug. Used by the
   * needs-X predicates so the architect doesn't expand past the colony's
   * maintenance capacity.
   */
  /** Count blueprints of this kind in any post-dig state (digging,
   * needs_furnishing, complete) regardless of upkeep. Use this for
   * "is there one at all?" gates — workshops, depots, libraries —
   * where the colony should stop after one and never re-emit a
   * duplicate even if the existing one falls into neglect. The
   * neglect-aware `maintainedAndActiveOfKind` still drives bedrooms
   * and farms where neglect SHOULD trigger fresh emissions. */
  private existingByKind(kind: BlueprintKind): number {
    let n = 0;
    for (const b of this.blueprints) {
      if (b.kind !== kind) continue;
      if (b.status === "digging" || b.status === "needs_furnishing" || b.status === "complete") n++;
    }
    return n;
  }

  private maintainedAndActiveOfKind(kind: BlueprintKind, currentTick: number): number {
    let n = 0;
    for (const b of this.blueprints) {
      if (b.kind !== kind) continue;
      if (b.status === "digging" || b.status === "needs_furnishing") {
        // In-progress rooms (digging or waiting for furniture) count
        // toward the active total so the planner doesn't emit a
        // duplicate while the first one is still being completed.
        n++;
        continue;
      }
      if (b.status !== "complete") continue;
      if (!isRoomNeglected(b, currentTick)) n++;
    }
    return n;
  }

  /**
   * True if the planner wants to dig another exploration corridor right now.
   * Tied to *completed* rooms (not just active emissions) so the colony
   * actually finishes some infrastructure before chasing tunnels — otherwise
   * the very first hour produces a corridor before any room exists.
   */
  private wantsExplorationCorridor(): boolean {
    if ((this.activeByKind()["corridor"] ?? 0) > 0) return false;
    const corridorTotal = this.totalOfKind("corridor");
    const completedRooms =
      (this.completedByKind["bedroom"] ?? 0) +
      (this.completedByKind["dining_hall"] ?? 0) +
      (this.completedByKind["stockpile"] ?? 0) +
      (this.completedByKind["mine"] ?? 0);
    const corridorTarget = Math.floor(completedRooms / 2);
    return corridorTotal < corridorTarget;
  }

  /**
   * The colony wants a stairwell roughly every five non-passage rooms it
   * builds. One active stairwell at a time so the architect doesn't
   * sink three parallel shafts in a row. Without this rhythm the
   * colony spreads sideways and never reaches the Gem Seam.
   */
  private wantsStairwell(): boolean {
    if ((this.activeByKind()["stairwell"] ?? 0) > 0) return false;
    const stairwellTotal = this.totalOfKind("stairwell");
    const completedRooms =
      (this.completedByKind["bedroom"] ?? 0) +
      (this.completedByKind["dining_hall"] ?? 0) +
      (this.completedByKind["stockpile"] ?? 0) +
      (this.completedByKind["mine"] ?? 0) +
      (this.completedByKind["kitchen"] ?? 0) +
      (this.completedByKind["brewery"] ?? 0) +
      (this.completedByKind["smelter"] ?? 0) +
      (this.completedByKind["forge"] ?? 0);
    const stairwellTarget = Math.floor(completedRooms / 5);
    return stairwellTotal < stairwellTarget;
  }

  // ---- Room placement (rectangles adjacent to walkable) ------------------

  private placeRoom(ctx: PlannerContext, kind: BlueprintKind): Blueprint | null {
    const dims = ROOM_DIMS[kind];
    const { grid } = ctx;
    let best: { x: number; y: number; score: number } | null = null;

    const xBias = (DEFAULT_STYLE as unknown as Record<string, number>)[kind] ?? 0;

    // Iterate every reachable walkable tile and try a placement anchored to
    // each of its four cardinal neighbours. Previously the search was a
    // ±60 box around spawn, which silently capped the colony to the Skin
    // layer — once corridors descended past that radius, no room could
    // land at the bottom of the shaft.
    const reachable = this.ensureReachable(ctx);
    const seen = new Set<number>();
    const w = grid.width;
    const halfW = Math.floor(dims.w / 2);
    const halfH = Math.floor(dims.h / 2);

    for (let i = 0; i < reachable.length; i++) {
      if (reachable[i] !== 1) continue;
      const wx = i % w;
      const wy = (i / w) | 0;
      // Four candidate origins: room extending right of, left of, below, or
      // above the walkable seed tile. Centred on the perpendicular axis so
      // the doorway lines up with where the dwarves are.
      const candidates: Array<[number, number]> = [
        [wx + 1, wy - halfH],         // right
        [wx - dims.w, wy - halfH],    // left
        [wx - halfW, wy + 1],         // below
        [wx - halfW, wy - dims.h],    // above
      ];
      for (const [ox, oy] of candidates) {
        const key = (oy << 16) | (ox & 0xffff);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!this.candidateValid(ctx, ox, oy, dims.w, dims.h)) continue;
        let score = this.scoreRoomCandidate(ox, oy, kind, ctx.spawn, xBias);
        // Pump stations pull strongly toward water so a dwarf on the
        // pump tile actually has something to drain. Without this
        // bias the planner can place a pump room across the colony
        // from the breach and findPumpTarget rejects it for "no
        // water in range".
        if (kind === "pump_station") {
          const waterTiles = countWaterNear(grid, ox + halfW, oy + halfH, 14);
          if (waterTiles === 0) {
            // No water at all near this candidate — skip it. A pump
            // far from any water is useless.
            continue;
          }
          score += waterTiles * 5;
        }
        // Stockpile follow-on placement: when the colony already has
        // a stockpile, the demand signal (recentFarHauls) is what
        // brought us here. Bias the second/third stockpile toward
        // the centroid of those slow pickups so the new drop point
        // actually shortens the haul that triggered it.
        if (kind === "stockpile" && this.existingByKind("stockpile") > 0) {
          const cutoff = ctx.tick - FAR_HAUL_AGE_TICKS_FOR_DEMAND;
          let cx = 0, cy = 0, n = 0;
          for (const e of ctx.recentFarHauls ?? []) {
            if (e.tick < cutoff) continue;
            cx += e.x; cy += e.y; n++;
          }
          if (n > 0) {
            const hx = cx / n;
            const hy = cy / n;
            const rx = ox + halfW;
            const ry = oy + halfH;
            const d = Math.sqrt((rx - hx) ** 2 + (ry - hy) ** 2);
            // Pull strength is competitive with depth + spread (each
            // ~30-80 points). Inverse distance with a ceiling so a
            // candidate sitting on the hot point dominates over a
            // far-away depth bonus.
            score += Math.max(0, 80 - d);
          }
        }
        if (
          best === null ||
          score > best.score ||
          (score === best.score && (oy < best.y || (oy === best.y && ox < best.x)))
        ) {
          best = { x: ox, y: oy, score };
        }
      }
    }

    if (!best) return null;
    return this.commitBlueprint(ctx, kind, best.x, best.y, dims.w, dims.h, rectCavity(best.x, best.y, dims.w, dims.h));
  }

  /**
   * Score a candidate room placement. The previous version used a
   * −dist² penalty against the spawn, which made every bedroom land
   * within spitting distance of the entrance. The new shape:
   *
   *   - Reward depth (+0.4 per tile below spawn, capped) so rooms follow
   *     the colony's descent rather than clustering at the surface.
   *   - Reward spread from the *nearest same-kind* room (capped at 30
   *     tiles distance) — bedrooms scatter, dining halls don't pile up.
   *   - Style bias (the existing left/right pull for dining/stockpile).
   *
   * The result: bedrooms place along the colony's descending shaft, not
   * shoulder-to-shoulder under the entrance.
   */
  private scoreRoomCandidate(
    ox: number,
    oy: number,
    kind: BlueprintKind,
    spawn: { x: number; y: number },
    xBias: number,
  ): number {
    let score = 0;
    // Depth reward: rooms further below the surface score better, with a
    // soft cap so absurdly-deep candidates aren't overweight.
    const depth = oy - spawn.y;
    score += Math.min(80, Math.max(0, depth)) * 0.4;
    if (depth < -2) score -= 40; // discourage placing rooms above the spawn
    // Spread bonus: prefer placement far from existing same-kind rooms.
    let nearest = Infinity;
    for (const b of this.blueprints) {
      if (b.kind !== kind) continue;
      const dx = ox - b.originX;
      const dy = oy - b.originY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearest) nearest = d;
    }
    if (nearest === Infinity) {
      // No same-kind rooms exist yet — neutral spread score.
      score += 30;
    } else {
      score += Math.min(60, nearest);
    }
    // Style bias (left/right pull) — preserved.
    if (xBias !== 0) score += xBias * (ox - spawn.x) * 0.5;
    return score;
  }

  // ---- Corridor placement (1-wide tunnels extending outward) -------------

  /**
   * Place a 1-tile-wide corridor whose first cell is adjacent to walkable
   * space and which extends CORRIDOR_MIN_LEN..CORRIDOR_MAX_LEN tiles in a
   * cardinal direction (preferring downward). Scoring blends direction
   * preference, length achieved, and distance from spawn.
   */
  private placeCorridor(ctx: PlannerContext): Blueprint | null {
    const { grid, spawn, rng } = ctx;
    // Per-emission variation. 30% chance of a 2-wide artery; otherwise 1.
    const wantWidth = rng.nextFloat() < 0.3 ? 2 : 1;
    const wantMaxLen = CORRIDOR_MIN_LEN + rng.nextRange(0, CORRIDOR_MAX_LEN - CORRIDOR_MIN_LEN + 1);

    interface Candidate {
      startX: number;
      startY: number;
      perpDx: number;
      perpDy: number;
      len: number;
      dx: number;
      dy: number;
      width: number;
      score: number;
    }

    // Collect the BEST candidate per cardinal direction. Selecting one per
    // direction (rather than a flat top-K by score) is what enforces
    // genuine variety: depth bias in the score makes every "down" candidate
    // outrank every lateral one, so a flat top-K samples almost exclusively
    // vertical strips. This way each direction competes only with itself
    // for the best location, then we pick across directions on weighted
    // probability — not score.
    const bestByDir = new Map<string, Candidate>();

    // Iterate every reachable walkable tile. Was previously a ±50 box around
    // spawn, which capped tunnel placement to the upper Skin layer once the
    // colony's deepest walkable tile exceeded that distance.
    const reachable = this.ensureReachable(ctx);
    const gridW = grid.width;
    for (let i = 0; i < reachable.length; i++) {
      if (reachable[i] !== 1) continue;
      const ax = i % gridW;
      const ay = (i / gridW) | 0;
      {
        for (const dir of CORRIDOR_DIRS) {
          // Try the desired width first; if 2-wide doesn't fit, fall back
          // to 1 (so we don't lose all candidates when wantWidth=2).
          const widths = wantWidth === 2 ? [2, 1] : [1];
          for (const tryWidth of widths) {
            const perp = perpendicularOf(dir.dx, dir.dy);
            const m = this.measureCorridor(grid, ax, ay, dir.dx, dir.dy, perp.dx, perp.dy, tryWidth, wantMaxLen);
            if (m.len < CORRIDOR_MIN_LEN) continue;
            const exitX = ax + dir.dx * m.len;
            const exitY = ay + dir.dy * m.len;
            const depthBonus = Math.max(0, exitY - spawn.y) * 4;
            const widthBonus = tryWidth === 2 ? 30 : 0;
            // Geology signal: count ore + gem tiles in the rock around
            // this corridor's exit. The dwarves "sense" mineral
            // density ahead of where they're digging, biasing the
            // colony toward veins it might otherwise miss while
            // descending. Cheap O((2R+1)²) per candidate; the
            // candidate set itself is bounded by reachable count.
            const geologyBonus = this.geologyAttraction(grid, exitX, exitY) * GEOLOGY_PER_TILE_BONUS;
            // No distance penalty: corridors *should* reach outward. The
            // squared penalty used previously made the score plateau around
            // 30 tiles from spawn, so the colony stalled before reaching
            // the ore-bearing Shallow Earth layer at y ≥ 80.
            const score = dir.pref + m.len * 5 + depthBonus + widthBonus + geologyBonus;
            const cand: Candidate = {
              startX: m.startX,
              startY: m.startY,
              perpDx: perp.dx,
              perpDy: perp.dy,
              len: m.len,
              dx: dir.dx,
              dy: dir.dy,
              width: tryWidth,
              score,
            };
            const key = `${dir.dx},${dir.dy}`;
            const existing = bestByDir.get(key);
            if (
              !existing ||
              cand.score > existing.score ||
              (cand.score === existing.score &&
                (cand.startY < existing.startY ||
                  (cand.startY === existing.startY && cand.startX < existing.startX)))
            ) {
              bestByDir.set(key, cand);
            }
            break; // accept the widest fit for this (position, direction)
          }
        }
      }
    }

    if (bestByDir.size === 0) return null;

    // Pick a direction with fixed weights so each emission has a real
    // chance of going laterally rather than always descending. Up direction
    // gets 0% weight — it's only ever picked as a last resort if no other
    // direction has any valid candidate.
    //
    // Geology signal also bumps the weight of any direction whose best
    // candidate scans dense ore: a strong vein off to the side can pull
    // the colony's direction roll toward it, not just the within-direction
    // exit choice. Without this the rightward / leftward bucket only
    // wins when the dice land that way; the signal makes that roll more
    // likely as the rumour intensifies.
    const dirWeights: Array<{ key: string; weight: number }> = [
      { key: "0,1", weight: 50 },   // down
      { key: "1,0", weight: 25 },   // right
      { key: "-1,0", weight: 25 },  // left
    ];
    const validWeighted = dirWeights
      .filter((d) => bestByDir.has(d.key))
      .map((d) => {
        const cand = bestByDir.get(d.key)!;
        const exitX = cand.startX + cand.dx * cand.len;
        const exitY = cand.startY + cand.dy * cand.len;
        const ore = this.geologyAttraction(grid, exitX, exitY);
        return { key: d.key, weight: d.weight + ore * 2 };
      });
    let chosen: Candidate | undefined;
    if (validWeighted.length > 0) {
      const totalW = validWeighted.reduce((s, d) => s + d.weight, 0);
      const r = rng.nextFloat() * totalW;
      let acc = 0;
      let pickedKey = validWeighted[0].key;
      for (const d of validWeighted) {
        acc += d.weight;
        if (r < acc) {
          pickedKey = d.key;
          break;
        }
      }
      chosen = bestByDir.get(pickedKey);
    } else {
      // Last resort: try whatever's left (e.g. only up has a valid run).
      const remaining = Array.from(bestByDir.values()).sort((a, b) => b.score - a.score);
      chosen = remaining[0];
    }
    if (!chosen) return null;

    // Build cavity for a width × len strip in (dx, dy) starting at the
    // first solid tile out from the seed; the perpendicular axis covers
    // `width` tiles.
    const cavity = new Int32Array(chosen.len * chosen.width);
    let idx = 0;
    let minX = chosen.startX, maxX = chosen.startX, minY = chosen.startY, maxY = chosen.startY;
    for (let k = 0; k < chosen.len; k++) {
      for (let p = 0; p < chosen.width; p++) {
        const tx = chosen.startX + chosen.dx * k + chosen.perpDx * p;
        const ty = chosen.startY + chosen.dy * k + chosen.perpDy * p;
        cavity[idx++] = (ty << 16) | tx;
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
    }
    return this.commitBlueprint(
      ctx,
      "corridor",
      minX,
      minY,
      maxX - minX + 1,
      maxY - minY + 1,
      cavity,
    );
  }

  /**
   * Walk in (dx, dy) from (ax, ay) up to maxLen steps; at each step verify a
   * `width`-wide perpendicular slab is solid + unclaimed. Returns the
   * largest achievable length and the start cell of the corridor (one step
   * out from the walkable seed).
   */
  private measureCorridor(
    grid: TileGrid,
    ax: number,
    ay: number,
    dx: number,
    dy: number,
    perpDx: number,
    perpDy: number,
    width: number,
    maxLen: number,
  ): { startX: number; startY: number; len: number } {
    const startX = ax + dx;
    const startY = ay + dy;
    let len = 0;
    for (let k = 1; k <= maxLen; k++) {
      let slabOk = true;
      for (let p = 0; p < width && slabOk; p++) {
        const tx = ax + dx * k + perpDx * p;
        const ty = ay + dy * k + perpDy * p;
        if (!grid.inBounds(tx, ty)) { slabOk = false; break; }
        if (!grid.isSolid(tx, ty)) { slabOk = false; break; }
        if (this.isClaimed(grid, tx, ty)) { slabOk = false; break; }
      }
      if (!slabOk) break;
      len++;
    }
    return { startX, startY, len };
  }

  // ---- Mine placement (cavities targeting ore veins) ---------------------

  /**
   * Find an Ore tile within ORE_SENSE_RADIUS of any walkable tile, then
   * place a 3×3 cavity that includes the ore and is itself adjacent to
   * walkable. Returns null if no valid placement exists yet — usually the
   * planner will then emit a corridor toward the nearest ore vein on a
   * later evaluation, exposing more candidates.
   */
  private placeMine(ctx: PlannerContext): Blueprint | null {
    const { grid } = ctx;
    const { w: mw, h: mh } = ROOM_DIMS["mine"];

    let bestOre: { x: number; y: number; score: number } | null = null;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.getTile(x, y) !== TileType.Ore) continue;
        if (this.isClaimed(grid, x, y)) continue;
        if (!this.tileNearReachable(ctx, x, y, ORE_SENSE_RADIUS)) continue;
        const dx = x - ctx.spawn.x;
        const dy = y - ctx.spawn.y;
        const score = -(dx * dx + dy * dy) + (dy > 0 ? 30 : 0);
        if (
          !bestOre ||
          score > bestOre.score ||
          (score === bestOre.score && (y < bestOre.y || (y === bestOre.y && x < bestOre.x)))
        ) {
          bestOre = { x, y, score };
        }
      }
    }
    if (!bestOre) return null;

    // Try every origin where the cavity covers the ore tile. For a 2×2
    // mine that's 4 candidate origins (top-left through bottom-right
    // anchored relative to the ore). The first valid one wins.
    for (let oyOff = 0; oyOff < mh; oyOff++) {
      for (let oxOff = 0; oxOff < mw; oxOff++) {
        const ox = bestOre.x - oxOff;
        const oy = bestOre.y - oyOff;
        if (!this.candidateValid(ctx, ox, oy, mw, mh)) continue;
        return this.commitBlueprint(ctx, "mine", ox, oy, mw, mh, rectCavity(ox, oy, mw, mh));
      }
    }
    return null;
  }

  /**
   * Chop down the nearest reachable tree. The cavity is exactly the
   * tree tile — no surrounding rock — so the dwarf walks up adjacent,
   * fells the tree, and the blueprint is done. Closest tree to spawn
   * wins so the surface clearing doesn't get strip-felled in random
   * order.
   */
  private placeLumberyard(ctx: PlannerContext): Blueprint | null {
    const { grid } = ctx;
    let bestTree: { x: number; y: number; score: number } | null = null;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.getTile(x, y) !== TileType.Tree) continue;
        if (this.isClaimed(grid, x, y)) continue;
        if (!this.tileNearReachable(ctx, x, y, 2)) continue;
        const dx = x - ctx.spawn.x;
        const dy = y - ctx.spawn.y;
        const score = -(dx * dx + dy * dy);
        if (
          !bestTree ||
          score > bestTree.score ||
          (score === bestTree.score && (y < bestTree.y || (y === bestTree.y && x < bestTree.x)))
        ) {
          bestTree = { x, y, score };
        }
      }
    }
    if (!bestTree) return null;
    const cavity = new Int32Array(1);
    cavity[0] = (bestTree.y << 16) | bestTree.x;
    return this.commitBlueprint(ctx, "lumberyard", bestTree.x, bestTree.y, 1, 1, cavity);
  }

  /** Geology signal — count solid Ore + Gem tiles within
   * GEOLOGY_SCAN_RADIUS of (x, y). Used to bias corridor placement
   * toward dense unmined veins so the colony's tunnels follow what
   * the dwarves can faintly sense. Cheap: a single bounded square
   * sweep. Gems weight a bit higher than plain ore — a gem cluster
   * is a stronger draw than the same count of dirt-iron. */
  private geologyAttraction(grid: import("../world/grid").TileGrid, x: number, y: number): number {
    let score = 0;
    const r = GEOLOGY_SCAN_RADIUS;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const tx = x + dx;
        const ty = y + dy;
        const t = grid.getTile(tx, ty);
        if (t === TileType.Ore || t === TileType.Adamantite || t === TileType.VoidOre) {
          score += 1;
        } else if (tileIsGem(t)) {
          score += 2;
        }
      }
    }
    return score;
  }

  /** True if there's a reachable walkable tile within `radius` of (x, y). */
  private tileNearReachable(ctx: PlannerContext, x: number, y: number, radius: number): boolean {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (this.isReachable(ctx, x + dx, y + dy)) return true;
      }
    }
    return false;
  }

  // ---- Common ------------------------------------------------------------

  /**
   * Common emit path: register the blueprint, mark claimed tiles, paint the
   * designation overlay so the renderer can show the planner's intent, and
   * narrate the new plan in the event log.
   */
  private commitBlueprint(
    ctx: PlannerContext,
    kind: BlueprintKind,
    originX: number,
    originY: number,
    width: number,
    height: number,
    cavity: Int32Array,
  ): Blueprint {
    const dims = ROOM_DIMS[kind];
    const bp: Blueprint = {
      id: this.nextId++,
      kind,
      originX,
      originY,
      width,
      height,
      cavity,
      status: "digging",
      priority: dims.priority,
      createdTick: ctx.tick,
    };
    this.blueprints.push(bp);
    this.markClaimed(ctx.grid, bp);
    this.markDesignations(ctx.grid, bp, true);
    if (ctx.events) {
      ctx.events.add(ctx.tick, "construction", narrateBlueprintBegin(ctx.rng, bp, ctx.spawn.y));
    }
    return bp;
  }

  private candidateValid(ctx: PlannerContext, ox: number, oy: number, w: number, h: number): boolean {
    const grid = ctx.grid;
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        if (!grid.inBounds(x, y)) return false;
        if (!grid.isSolid(x, y)) return false;
        if (this.isClaimed(grid, x, y)) return false;
      }
    }
    // Reject placements where the cavity's ceiling is too close to
    // the surface. We don't have surfaceY in the planner, so detect
    // it directly: if Air sits within ROOM_CEILING_BUFFER tiles
    // above any cavity column, the carved room would be exposed to
    // sky. Corridors and the lumberyard reach the surface through
    // their own placement paths and are unaffected.
    for (let x = ox; x < ox + w; x++) {
      for (let d = 1; d <= ROOM_CEILING_BUFFER; d++) {
        const y = oy - d;
        if (!grid.inBounds(x, y)) continue;
        if (grid.getTile(x, y) === TileType.Air) return false;
      }
    }
    // The cavity must touch a walkable tile that is itself reachable from
    // spawn — otherwise we'd be designating a cavity in a disconnected
    // worldgen cavern that the dwarves can never path to.
    let touchesReachable = false;
    for (let y = oy - 1; y <= oy + h && !touchesReachable; y++) {
      for (let x = ox - 1; x <= ox + w && !touchesReachable; x++) {
        if (!grid.inBounds(x, y)) continue;
        if (x >= ox && x < ox + w && y >= oy && y < oy + h) continue;
        if (this.isReachable(ctx, x, y)) touchesReachable = true;
      }
    }
    return touchesReachable;
  }

  // ---- Reachable-from-spawn flood fill -----------------------------------

  /**
   * Read-only accessor for the reachable-from-spawn mask. Used by the
   * hostile spawn system to pick a candidate tile that's connected to the
   * colony but far from any dwarf — without forcing the planner internals
   * to know about hostiles.
   */
  exposeReachable(sim: { grid: TileGrid; spawn: { x: number; y: number } }): Uint8Array | null {
    return this.ensureReachable({
      grid: sim.grid,
      spawn: sim.spawn,
      tick: 0,
      population: 0,
      // ensureReachable reads only grid + spawn; rng/events/tick are unused.
      rng: undefined as unknown as import("../rng").Rng,
    });
  }


  /** True if (x, y) is walkable AND connected to spawn via walkable tiles. */
  private isReachable(ctx: PlannerContext, x: number, y: number): boolean {
    if (!ctx.grid.inBounds(x, y)) return false;
    const r = this.ensureReachable(ctx);
    return r[y * ctx.grid.width + x] === 1;
  }

  private ensureReachable(ctx: PlannerContext): Uint8Array {
    const grid = ctx.grid;
    if (
      !this.reachable ||
      this.reachableW !== grid.width ||
      this.reachable.length !== grid.width * grid.height
    ) {
      this.reachable = new Uint8Array(grid.width * grid.height);
      this.reachableW = grid.width;
      this.reachableDirty = true;
    }
    if (!this.reachableDirty) return this.reachable;
    this.reachable.fill(0);
    if (!grid.isWalkable(ctx.spawn.x, ctx.spawn.y)) {
      // Spawn somehow not walkable — leave mask empty (no candidates valid).
      this.reachableDirty = false;
      return this.reachable;
    }
    const w = grid.width;
    const queue = new Int32Array(grid.width * grid.height);
    let head = 0;
    let tail = 0;
    const startIdx = ctx.spawn.y * w + ctx.spawn.x;
    queue[tail++] = startIdx;
    this.reachable[startIdx] = 1;
    while (head < tail) {
      const idx = queue[head++];
      const cx = idx % w;
      const cy = (idx / w) | 0;
      // 4-connected; pathing is 8-connected but the reachable check is
      // conservative. A 4-connected flood-fill is a subset of 8-connected
      // reachability — every 4-reachable tile is also 8-reachable.
      for (const [dx, dy] of REACH_DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
        if (!grid.isWalkable(nx, ny)) continue;
        const nidx = ny * w + nx;
        if (this.reachable[nidx]) continue;
        this.reachable[nidx] = 1;
        queue[tail++] = nidx;
      }
    }
    this.reachableDirty = false;
    return this.reachable;
  }

  // ---- Inspection / counts -----------------------------------------------

  containsTile(grid: TileGrid, x: number, y: number): boolean {
    if (!grid.inBounds(x, y)) return false;
    return this.isClaimed(grid, x, y);
  }

  hasActive(): boolean {
    for (const b of this.blueprints) if (b.status === "digging") return true;
    return false;
  }

  /** Returns true if the architect should be willing to emit a room
   * of `kind`. The gate has two satisfying conditions: the producer
   * workshop is operational (some blueprint of the producer kind is
   * complete), OR an item of any required furniture kind is already
   * sitting somewhere in the world (founder-kit drop, a prior
   * workshop output left over from before the workshop was lost,
   * a caravan import). Returns true for kinds with no producer gate
   * — carpenter / mason / farm / corridor / stairwell / etc. */
  private producerReady(kind: BlueprintKind, ctx: PlannerContext): boolean {
    const producer = ROOM_PRODUCER[kind];
    if (!producer) return true;
    for (const b of this.blueprints) {
      if (b.kind === producer && b.status === "complete") return true;
    }
    // No operational producer yet. Fall back to "is a furniture
    // item of the right kind already on the floor somewhere?" — if
    // yes, the room can be furnished from existing supply.
    // Callers without an availableFurniture set (planner-only
    // tests, callers that haven't opted in) get the legacy
    // "no gate" behavior so existing test fixtures keep emitting.
    const avail = ctx.availableFurniture;
    if (!avail) return true;
    const reqs = FURNITURE_REQUIREMENTS[kind];
    if (reqs) {
      for (const r of reqs) if (avail.has(r.item)) return true;
    }
    return false;
  }

  activeCount(): number {
    let n = 0;
    for (const b of this.blueprints) if (b.status === "digging") n++;
    return n;
  }

  /** Recent dug-out rooms still waiting on a furniture haul. The
   * planner uses this as a separate backlog gate: when the queue of
   * needs_furnishing rooms outgrows what the hauling crew can clear,
   * the architect pauses new emissions so haulers can catch up
   * instead of fanning the backlog wider. Distinct from activeCount
   * (which still throttles parallel digging) — a colony with the
   * carpenter and mason already crafting can fill several
   * needs_furnishing rooms simultaneously, so we let the architect
   * keep working until the backlog truly outstrips throughput.
   * Rooms older than FURNISHING_BACKLOG_AGE_TICKS drop out of the
   * count — if a room's been sitting in needs_furnishing for a full
   * day, the issue isn't hauler bandwidth (which is the backlog
   * gate's concern), it's something more structural that opening
   * fewer cavities won't fix. */
  furnishingBacklog(now: number): number {
    const cutoff = now - FURNISHING_BACKLOG_AGE_TICKS;
    let n = 0;
    for (const b of this.blueprints) {
      if (b.status !== "needs_furnishing") continue;
      if (b.createdTick < cutoff) continue;
      n++;
    }
    return n;
  }

  private activeByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of this.blueprints) {
      // A blueprint waiting on furniture (needs_furnishing) is
      // still in flight — the cavity is dug and a hauler is en
      // route. Count it toward the per-kind emission cap so the
      // planner doesn't keep spawning duplicate breweries while
      // the first one is waiting for its barrel to land.
      if (b.status !== "digging" && b.status !== "needs_furnishing") continue;
      out[b.kind] = (out[b.kind] ?? 0) + 1;
    }
    return out;
  }

  private totalOfKind(kind: BlueprintKind): number {
    return (this.completedByKind[kind] ?? 0) + (this.activeByKind()[kind] ?? 0);
  }

  private harvestCompleted(ctx: PlannerContext): void {
    const grid = ctx.grid;
    for (const b of this.blueprints) {
      if (b.status === "digging" && isComplete(b, grid)) {
        // A freshly-dug room counts as fully maintained — the dig itself
        // exercised every cell. The maintenance clock starts now, and
        // quality starts at the freshly-dug baseline. Later sessions
        // raise quality through maintenance + (eventually) decoration.
        b.lastMaintainedTick = ctx.tick;
        if (b.quality === undefined) b.quality = QUALITY_BASE;
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          grid.setDesignation(x, y, 0);
        }
        // Two paths now. Kinds that take crafted furniture
        // (FURNITURE_REQUIREMENTS) flip to needs_furnishing and wait
        // for haulers to deliver beds / barrels / etc. Other kinds
        // still auto-stamp via furnishRoom and go straight to
        // complete — they'll get migrated to the new pipeline in
        // follow-up commits.
        const reqs = FURNITURE_REQUIREMENTS[b.kind];
        if (reqs && reqs.length > 0) {
          b.status = "needs_furnishing";
          b.furniturePlaced = {};
          // Place the door so the room is enclosed even before its
          // furniture lands — a bedroom-shaped cavity with no door is
          // just a hallway nook.
          prepareInfrastructureForFurnishing(grid, b);
          if (ctx.events) {
            ctx.events.add(
              ctx.tick,
              "construction",
              `${BLUEPRINT_KIND_LABELS[b.kind]} dug. Awaiting ${reqs.map((r) => `${r.count} ${r.item}`).join(", ")}.`,
            );
          }
        } else {
          b.status = "complete";
          this.completed++;
          this.completedByKind[b.kind] = (this.completedByKind[b.kind] ?? 0) + 1;
          furnishRoom(grid, b);
          if (ctx.events) {
            ctx.events.add(ctx.tick, "construction", narrateBlueprintComplete(ctx.rng, b, ctx.spawn.y));
          }
        }
      }
    }
    // Walkable area changes whenever a tile gets mined, not just when a
    // blueprint fully completes — partial digs in long corridors expand the
    // reachable set too. Just invalidate every tick; the rebuild is only
    // actually run on demand in the next planner evaluation (hourly).
    this.reachableDirty = true;
  }

  // ---- Spatial index helpers ---------------------------------------------

  private ensureClaimedIndex(grid: TileGrid): Int32Array {
    if (!this.claimedBy || this.claimedW !== grid.width || this.claimedBy.length !== grid.width * grid.height) {
      const arr = new Int32Array(grid.width * grid.height);
      arr.fill(-1);
      this.claimedBy = arr;
      this.claimedW = grid.width;
      for (const b of this.blueprints) {
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          arr[y * grid.width + x] = b.id;
        }
      }
    }
    return this.claimedBy;
  }

  private isClaimed(grid: TileGrid, x: number, y: number): boolean {
    const arr = this.ensureClaimedIndex(grid);
    return arr[y * grid.width + x] !== -1;
  }

  private markClaimed(grid: TileGrid, b: Blueprint): void {
    const arr = this.ensureClaimedIndex(grid);
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      arr[y * grid.width + x] = b.id;
    }
  }

  private markDesignations(grid: TileGrid, b: Blueprint, on: boolean): void {
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      const x = c & 0xffff;
      const y = (c >>> 16) & 0xffff;
      grid.setDesignation(x, y, on ? 1 : 0);
    }
  }

  rehydrate(grid: TileGrid): void {
    this.claimedBy = null;
    this.ensureClaimedIndex(grid);
    this.completedByKind = {};
    for (const b of this.blueprints) {
      if (b.status === "complete") {
        this.completedByKind[b.kind] = (this.completedByKind[b.kind] ?? 0) + 1;
      }
      if (b.status === "digging") this.markDesignations(grid, b, true);
    }
  }

  buildSummary(): { kind: BlueprintKind; active: number; complete: number }[] {
    const kinds: BlueprintKind[] = ["bedroom", "dining_hall", "stockpile", "corridor", "mine", "stairwell"];
    const active = this.activeByKind();
    const out: { kind: BlueprintKind; active: number; complete: number }[] = [];
    for (const k of kinds) {
      const a = active[k] ?? 0;
      const c = this.completedByKind[k] ?? 0;
      if (a + c > 0) out.push({ kind: k, active: a, complete: c });
    }
    return out;
  }
}

export type { Blueprint };
