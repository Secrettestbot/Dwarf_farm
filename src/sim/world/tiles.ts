// One byte per tile. The first 32 IDs are reserved for terrain & basic
// constructions; later tiers can fill the rest as they become relevant.

export const enum TileType {
  Air = 0,
  Dirt = 1,
  Sand = 2,
  Stone = 3,
  Granite = 4,
  Ore = 5, // generic ore for session 1; later sessions split iron/copper/silver/etc.
  CavernFloor = 6, // pre-dug naturally open ground (worldgen-carved)
  CorridorFloor = 7, // mined-out floor
  Water = 8,
  Lava = 9,
  Designated = 10, // marker overlay; never an actual ground state
  // Furniture — placed when a blueprint is harvested complete. All walkable
  // (dwarves can stand on them) so pathfinding doesn't need to special-case.
  Bed = 11,        // bedroom: 1 per cavity, faster sleep restoration
  Table = 12,      // dining hall: a few per cavity, decorative for now
  Bin = 13,        // stockpile: a few per cavity, decorative for now
  // Persistent marker placed when a dwarf dies on this spot. Walkable but
  // visually distinct so the colony's history is legible in the geometry
  // itself — a future survivor mining nearby will see where their elders
  // fell.
  Memorial = 14,
  // A productive farm cell. Walkable. Each in-game hour, with some
  // probability, contributes a unit of food to the stockpile (full
  // farming/harvesting jobs land in a later session — for now the food
  // arrives abstractly, the way underground subsistence farming
  // implicitly works in the GDD).
  FarmTile = 15,
  // Workshop workstations — the focal tile of a workshop room where the
  // crafter dwarf stands while running a recipe. One workstation per
  // cavity for the simple session-3 implementation; more elaborate
  // multi-station workshops land later.
  KitchenStation = 16,
  BreweryStation = 17,
  SmelterStation = 18,
  ForgeStation = 19,
  /** A scholar's desk in the Library. Walkable; a dwarf with the
   * "research" job stands on it while their progress accumulates. */
  LibraryDesk = 20,
  // Gem Seam content (§5.2 Layer 4): rough gemstones embedded in the
  // rock. Solid like ore, mined to the same dropped-item flow once the
  // Tier 3 Gem Cutting research lands.
  RawDiamond = 21,
  RawRuby = 22,
  RawEmerald = 23,
  /** Magma vent — Layer 4 hazard / future fuel source for magma forges
   * (Tier 4 research). Walkable but lethal. For now decorative. */
  MagmaVent = 24,
  /** Pre-built dwarven ruin (§5.2 Layer 4): walkable floor with a
   * distinct visual marker, signalling places where future Tier 5
   * ancient-text research can be performed. */
  AncientRuin = 25,
  // Layer 5+ content: the Ancient Dark and the Underworld below it.
  /** Adamantite vein — Layer 5 ore (§5.2). Mined like ore but counts as
   * its own metal once a smelter / forge integration arrives. */
  Adamantite = 26,
  /** Void-ore — found in Layer 6 (§5.2 Underworld). The only material
   * the Hollow King's physical form cannot destroy. */
  VoidOre = 27,
  /** Soul-crystal — Tier 5 special gem with attunement properties. */
  SoulCrystal = 28,
  /** Armoury rack — decorative storage spot for weapons in an Armoury
   * room. Walkable so soldiers can step in to grab a weapon. The
   * mechanical effect (equipping a soldier) lands on the draft tick;
   * this tile is the visual signal that a fortress has armed itself. */
  ArmouryRack = 29,
  /** Silver vein — sits in Deep Rock per GDD §5.2 ("silver, gold, coal
   * seams"). Mined like ore, drops an ore item, and triggers the
   * Silver Halls milestone the first time a dwarf strikes one. A
   * future commit can split it into its own item kind once silver-as-
   * trade-good has a downstream consumer. */
  Silver = 30,
  /** Throne — centerpiece of the Throne Room (GDD §10.2 milestone
   * "The Grand Citadel"). Walkable; rendered as a deep purple to read
   * as ceremonial. Decorative for now — the chair sits where it sits. */
  Throne = 31,
  /** Aquifer rock — Shallow Earth pocket of stone saturated with
   * water (GDD §5.2 "aquifer pockets — risky to breach without a
   * pump room"). Mineable like ore; striking it spawns Water that
   * spreads into adjacent corridors. The Aquifer Survived milestone
   * fires once the colony lives through the flood. */
  Aquifer = 32,
  /** Pump station — workstation tile in a Pump Station room (GDD
   * §10.2 Tier 2 Hydraulic Basics). A dwarf working at this tile
   * drains one adjacent water tile per pump cycle, reclaiming flooded
   * corridors after an aquifer breach. */
  PumpStation = 33,
  /** Mason's bench — workstation in a Mason's Workshop (GDD §10.2
   * Tier 1 Basic Stonecutting). Cuts loose stone into blocks. */
  MasonStation = 34,
  /** Jeweller's bench — workstation in a Jeweller's Workshop (GDD
   * §10.2 Tier 3 Gem Cutting). Cuts rough gems into cut gems for
   * trade and inlay. */
  JewellerStation = 35,
  /** Surface ground — a walkable patch of grass around the entrance.
   * Distinct from CavernFloor so the renderer can paint it as an
   * outdoor tile and worldgen can decide where to seed trees. */
  Grass = 36,
  /** A surface tree. Solid like a rock pillar; mining one ("logging")
   * drops a wood item and leaves Grass behind. The colony's source of
   * wood for the Carpenter's Workshop. */
  Tree = 37,
  /** Carpenter's bench — workstation in a Carpenter's Workshop (GDD
   * §7.1 / §10.2 Tier 1 Basic Carpentry). Turns logs into planks. */
  CarpenterStation = 38,
  /** Kiln — fires loose dirt into pottery (GDD §10.2 Tier 2 Pottery
   * & Kilns). Hot and slow; sits at the centre of a Kiln workshop. */
  KilnStation = 39,
  /** Tanning bench — workstation in a Tannery (GDD §10.2 Tier 2
   * Textile Craft). Soaks raw hides into supple leather. */
  TannerStation = 40,
  /** Loom — workstation in a Loom Workshop (GDD §10.2 Tier 1 Rope &
   * Fibre). Spins rope into cloth. */
  LoomStation = 41,
  /** Hospital cot — heals faster than a regular bed and credits the
   * colony's best-skilled medic with medicine XP every tick a wounded
   * dwarf rests on it (GDD §10.2 Tier 2 Medical Practice). */
  HospitalBed = 42,
  /** Tavern counter — focal tile of a Tavern room. The barkeep stands
   * here while pouring; visiting dwarves get a morale bump for stopping
   * by. */
  TavernCounter = 43,
  /** Gold vein — Deep Rock content (GDD §5.2 "silver, gold, coal
   * seams"). Mined like ore; drops a gold ore item and fires the
   * Gilded Halls milestone the first time the colony strikes one. */
  Gold = 44,
  /** Coal seam — Deep Rock fuel material (GDD §5.2). Mined like ore;
   * drops a generic ore item for now. Future smelter / forge tiers
   * will route coal as fuel separately. */
  Coal = 45,
  /** Cave mushroom cluster — naturally lit edible fungus growing in
   * cavern floors (GDD §5.2 "mushroom forests"). Mineable; drops a
   * food item the colony can eat or cook. */
  CaveMushroom = 46,
  /** Closed-but-walkable door — sits at a room's entrance cell.
   * Walkable in normal play; the lockdown emergency converts each
   * Door to DoorBarred so the perimeter actually closes. */
  Door = 47,
  /** Barred door — non-walkable. Only set during lockdown emergencies;
   * lifting the lockdown swaps every DoorBarred back to Door. */
  DoorBarred = 48,
  /** Magma Forge — Tier 4 (Magma Forge Craft) workshop tile.
   * Functionally a forge fed by a tapped magma vent; outputs are
   * higher quality and produced faster. */
  MagmaForgeStation = 49,
  /** Water wheel — Tier 2 (Carpentry: Mechanisms) construction. Sits
   * adjacent to Water tiles and boosts the speed of nearby workshops
   * via a passive aura — the GDD's hand-wave for "the colony has
   * mechanical power". */
  WaterWheel = 50,
  /** Empty grave plot — the floor of a Cemetery room before anyone is
   * buried in it. Walkable so survivors can walk between plots. */
  Grave = 51,
  /** Occupied grave — a Cemetery plot that holds a buried dwarf.
   * The colony's `graves` registry stores who's interred there
   * (name, profession, age, tick of death). Walkable so visitors can
   * stand at the headstone. */
  Headstone = 52,
  /** Brewing barrel — the wooden cask the brewer pours ale into. A
   * Brewery is only functional once at least one Barrel has been
   * delivered (Carpenter's Workshop recipe: 2 planks → 1 barrel).
   * Walkable so the brewer can step around the room without
   * tripping over the cask. */
  BrewingBarrel = 53,
}

export interface TileInfo {
  name: string;
  walkable: boolean;
  solid: boolean; // can be mined
  // RGB for the flat-color render path used before sprites come online.
  color: number;
}

export const TILE_INFO: Record<number, TileInfo> = {
  [TileType.Air]: { name: "air", walkable: false, solid: false, color: 0x000000 },
  [TileType.Dirt]: { name: "dirt", walkable: false, solid: true, color: 0x6b4a2b },
  [TileType.Sand]: { name: "sand", walkable: false, solid: true, color: 0xb89868 },
  [TileType.Stone]: { name: "stone", walkable: false, solid: true, color: 0x6a6a72 },
  [TileType.Granite]: { name: "granite", walkable: false, solid: true, color: 0x4a4a55 },
  [TileType.Ore]: { name: "ore", walkable: false, solid: true, color: 0x8a6a3a },
  [TileType.CavernFloor]: { name: "cavern floor", walkable: true, solid: false, color: 0x2a2620 },
  [TileType.CorridorFloor]: { name: "corridor floor", walkable: true, solid: false, color: 0x322c24 },
  [TileType.Water]: { name: "water", walkable: false, solid: false, color: 0x2244aa },
  [TileType.Lava]: { name: "lava", walkable: false, solid: false, color: 0xcc4400 },
  [TileType.Designated]: { name: "designated", walkable: false, solid: false, color: 0x665500 },
  [TileType.Bed]: { name: "bed", walkable: true, solid: false, color: 0xa04030 },
  [TileType.Table]: { name: "table", walkable: true, solid: false, color: 0x8a6a3a },
  [TileType.Bin]: { name: "bin", walkable: true, solid: false, color: 0x5a4633 },
  [TileType.Memorial]: { name: "memorial", walkable: true, solid: false, color: 0xc0a070 },
  [TileType.FarmTile]: { name: "farm", walkable: true, solid: false, color: 0x6a8a3a },
  [TileType.KitchenStation]: { name: "kitchen", walkable: true, solid: false, color: 0xc06040 },
  [TileType.BreweryStation]: { name: "brewery", walkable: true, solid: false, color: 0x5a8a40 },
  [TileType.SmelterStation]: { name: "smelter", walkable: true, solid: false, color: 0xa05030 },
  [TileType.ForgeStation]: { name: "forge", walkable: true, solid: false, color: 0xb07040 },
  [TileType.LibraryDesk]: { name: "desk", walkable: true, solid: false, color: 0x6080a0 },
  [TileType.RawDiamond]: { name: "raw diamond", walkable: false, solid: true, color: 0xc8e0e8 },
  [TileType.RawRuby]: { name: "raw ruby", walkable: false, solid: true, color: 0xa83040 },
  [TileType.RawEmerald]: { name: "raw emerald", walkable: false, solid: true, color: 0x40a058 },
  [TileType.MagmaVent]: { name: "magma vent", walkable: true, solid: false, color: 0xd84020 },
  [TileType.AncientRuin]: { name: "ancient ruin", walkable: true, solid: false, color: 0x9080a0 },
  [TileType.Adamantite]: { name: "adamantite", walkable: false, solid: true, color: 0xc8d0ff },
  [TileType.VoidOre]: { name: "void-ore", walkable: false, solid: true, color: 0x402850 },
  [TileType.SoulCrystal]: { name: "soul-crystal", walkable: false, solid: true, color: 0x7090e0 },
  [TileType.ArmouryRack]: { name: "armoury rack", walkable: true, solid: false, color: 0x8090a8 },
  [TileType.Silver]: { name: "silver vein", walkable: false, solid: true, color: 0xd0d8e8 },
  [TileType.Throne]: { name: "throne", walkable: true, solid: false, color: 0x6040a0 },
  [TileType.Aquifer]: { name: "aquifer", walkable: false, solid: true, color: 0x3a5078 },
  [TileType.PumpStation]: { name: "pump", walkable: true, solid: false, color: 0x4080a0 },
  [TileType.MasonStation]: { name: "mason's bench", walkable: true, solid: false, color: 0x9090a0 },
  [TileType.JewellerStation]: { name: "jeweller's bench", walkable: true, solid: false, color: 0xb888d0 },
  [TileType.Grass]: { name: "grass", walkable: true, solid: false, color: 0x4a8c3a },
  [TileType.Tree]: { name: "tree", walkable: false, solid: true, color: 0x3a6c28 },
  [TileType.CarpenterStation]: { name: "carpenter's bench", walkable: true, solid: false, color: 0xc08a4a },
  [TileType.KilnStation]: { name: "kiln", walkable: true, solid: false, color: 0xb86040 },
  [TileType.TannerStation]: { name: "tanner's bench", walkable: true, solid: false, color: 0x886040 },
  [TileType.LoomStation]: { name: "loom", walkable: true, solid: false, color: 0xd0c8b0 },
  [TileType.HospitalBed]: { name: "hospital cot", walkable: true, solid: false, color: 0xd0a0a0 },
  [TileType.TavernCounter]: { name: "tavern counter", walkable: true, solid: false, color: 0x9a6a3a },
  [TileType.Gold]: { name: "gold vein", walkable: false, solid: true, color: 0xe8c860 },
  [TileType.Coal]: { name: "coal seam", walkable: false, solid: true, color: 0x202028 },
  [TileType.CaveMushroom]: { name: "cave mushrooms", walkable: false, solid: true, color: 0xc8a8d8 },
  [TileType.Door]: { name: "door", walkable: true, solid: false, color: 0x8a6a3a },
  [TileType.DoorBarred]: { name: "barred door", walkable: false, solid: false, color: 0x4a3a28 },
  [TileType.MagmaForgeStation]: { name: "magma forge", walkable: true, solid: false, color: 0xe04020 },
  [TileType.WaterWheel]: { name: "water wheel", walkable: true, solid: false, color: 0x506080 },
  [TileType.Grave]: { name: "grave plot", walkable: true, solid: false, color: 0x504838 },
  [TileType.Headstone]: { name: "headstone", walkable: true, solid: false, color: 0x9a8a72 },
  [TileType.BrewingBarrel]: { name: "brewing barrel", walkable: true, solid: false, color: 0x7a5028 },
};

export function tileIsGem(t: number): boolean {
  return t === TileType.RawDiamond || t === TileType.RawRuby || t === TileType.RawEmerald;
}

export function tileIsWorkshopStation(t: number): boolean {
  return (
    t === TileType.KitchenStation ||
    t === TileType.BreweryStation ||
    t === TileType.SmelterStation ||
    t === TileType.ForgeStation
  );
}

export function tileIsBed(t: number): boolean {
  return t === TileType.Bed || t === TileType.HospitalBed;
}

export function tileIsFurniture(t: number): boolean {
  return t === TileType.Bed || t === TileType.HospitalBed || t === TileType.Table || t === TileType.Bin;
}

export function tileWalkable(t: number): boolean {
  return TILE_INFO[t]?.walkable ?? false;
}

export function tileSolid(t: number): boolean {
  return TILE_INFO[t]?.solid ?? false;
}

export function tileColor(t: number): number {
  return TILE_INFO[t]?.color ?? 0xff00ff;
}
