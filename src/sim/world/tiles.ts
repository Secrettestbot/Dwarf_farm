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
};

export function tileWalkable(t: number): boolean {
  return TILE_INFO[t]?.walkable ?? false;
}

export function tileSolid(t: number): boolean {
  return TILE_INFO[t]?.solid ?? false;
}

export function tileColor(t: number): number {
  return TILE_INFO[t]?.color ?? 0xff00ff;
}
