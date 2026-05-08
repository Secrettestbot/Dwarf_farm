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
  return t === TileType.Bed;
}

export function tileIsFurniture(t: number): boolean {
  return t === TileType.Bed || t === TileType.Table || t === TileType.Bin;
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
