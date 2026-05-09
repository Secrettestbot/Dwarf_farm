import { TileGrid } from "./grid";
import { TileType } from "./tiles";
import { fbm2, noise2 } from "./noise";

export interface WorldGenParams {
  seed: number;
  width: number;
  height: number;
}

export interface SpawnInfo {
  x: number;
  y: number;
}

export interface WorldGenResult {
  grid: TileGrid;
  spawn: SpawnInfo;
  surfaceY: Int32Array; // surfaceY[x] = first non-air row (top of dirt) per column
}

/**
 * Phase 1 world: 200×500 (or whatever the caller asked for).
 * Layers:
 *   Skin           y in [0, 80)   — sky above terrain, then dirt/sand with stone pockets.
 *   Shallow Earth  y in [80, 300) — sandstone & limestone (rendered as Stone), iron ore.
 *   Deep Rock      y in [300, ∞)  — granite, ore veins.
 *
 * The output is fully a function of (seed, width, height) — re-running with the
 * same params yields byte-identical chunks, which is what makes the
 * "regen+overrides" save format possible.
 */
export function generateWorld(params: WorldGenParams): WorldGenResult {
  const { seed, width, height } = params;
  const grid = new TileGrid(width, height);
  const surfaceY = new Int32Array(width);

  const surfaceSeed = seed ^ 0xa1c01a;
  const cavernSeed = seed ^ 0xcafe1234;
  const oreSeed = seed ^ 0x07e07e07;

  // 1. Surface heightmap. Mid Phase-1 world has surface around y=24.
  const baseSurface = Math.floor(height * 0.05); // 25 for height=500
  for (let x = 0; x < width; x++) {
    const n = fbm2(surfaceSeed, x * 0.02, 0, 4, 0.5, 2);
    surfaceY[x] = clamp(Math.round(baseSurface + n * 6), 5, baseSurface + 12);
  }

  // 2. Per-column terrain fill.
  for (let x = 0; x < width; x++) {
    const sy = surfaceY[x];
    for (let y = 0; y < height; y++) {
      let t: TileType = TileType.Air;
      if (y < sy) {
        t = TileType.Air;
      } else {
        const depth = y - sy;
        // Layer band selection.
        if (depth < 5) {
          // Soil cap.
          t = TileType.Dirt;
        } else if (y < 80) {
          // Skin layer body.
          const sandN = noise2(surfaceSeed + 7, x * 0.08, y * 0.08);
          t = sandN > 0.35 ? TileType.Sand : TileType.Dirt;
          // Stone pockets.
          if (noise2(surfaceSeed + 11, x * 0.13, y * 0.13) > 0.55) t = TileType.Stone;
        } else if (y < 300) {
          // Shallow earth: stone with occasional ore. Pockets of
          // aquifer rock sit in here per GDD §5.2 — water-saturated
          // stone the dwarves should be wary of mining.
          t = TileType.Stone;
          if (noise2(oreSeed, x * 0.18, y * 0.18) > 0.62) t = TileType.Ore;
          if (noise2(oreSeed + 89, x * 0.12, y * 0.12) > 0.78) t = TileType.Aquifer;
        } else if (y < 700) {
          // Deep rock: granite with rare ore and the first silver veins.
          t = TileType.Granite;
          if (noise2(oreSeed + 31, x * 0.22, y * 0.22) > 0.72) t = TileType.Ore;
          // Silver pockets — rarer than iron ore. GDD §5.2 places
          // silver / gold / coal seams in this band.
          if (noise2(oreSeed + 67, x * 0.30, y * 0.30) > 0.86) t = TileType.Silver;
          // Occasional stone vein for variety.
          if (noise2(oreSeed + 53, x * 0.05, y * 0.05) > 0.55) t = TileType.Stone;
        } else if (y < 1200) {
          // Gem Seam: dense igneous rock with gem clusters and rare
          // magma vents. Diamonds are the rarest cluster, emeralds the
          // most common.
          t = TileType.Granite;
          const gemN = noise2(oreSeed + 73, x * 0.30, y * 0.30);
          const variantN = noise2(oreSeed + 97, x * 0.55, y * 0.55);
          if (gemN > 0.78) {
            t = variantN > 0.4 ? TileType.RawEmerald : variantN > 0.0 ? TileType.RawRuby : TileType.RawDiamond;
          } else if (noise2(oreSeed + 113, x * 0.18, y * 0.18) > 0.85) {
            t = TileType.MagmaVent;
          } else if (noise2(oreSeed + 31, x * 0.22, y * 0.22) > 0.78) {
            t = TileType.Ore;
          }
        } else if (y < 1600) {
          // Ancient Dark (Layer 5): solid granite, near-silent. Sparse
          // ancient ruins poke through, plus the first adamantite veins
          // and rare soul-crystal pockets.
          t = TileType.Granite;
          const ruinN = noise2(oreSeed + 137, x * 0.06, y * 0.06);
          const adaN = noise2(oreSeed + 149, x * 0.18, y * 0.18);
          const soulN = noise2(oreSeed + 163, x * 0.32, y * 0.32);
          if (ruinN > 0.86) t = TileType.AncientRuin;
          else if (soulN > 0.88) t = TileType.SoulCrystal;
          else if (adaN > 0.78) t = TileType.Adamantite;
          else if (noise2(oreSeed + 31, x * 0.22, y * 0.22) > 0.80) t = TileType.Ore;
        } else {
          // Underworld (Layer 6, §5.2): impossible architecture. Mostly
          // dense rock with veins of void-ore and the occasional ancient
          // ruin. The Hollow King's domain — narrative awakens when the
          // first dwarf stands at this depth.
          t = TileType.Granite;
          const voidN = noise2(oreSeed + 191, x * 0.20, y * 0.20);
          const adaN = noise2(oreSeed + 211, x * 0.18, y * 0.18);
          if (voidN > 0.74) t = TileType.VoidOre;
          else if (adaN > 0.74) t = TileType.Adamantite;
          else if (noise2(oreSeed + 137, x * 0.06, y * 0.06) > 0.86) t = TileType.AncientRuin;
        }

        // 3. Carve natural caverns. fbm gives big blob shapes; threshold cuts holes.
        const cav = fbm2(cavernSeed, x * 0.04, y * 0.04, 3, 0.55, 2.1);
        // Caverns only below the soil cap so we don't punch random holes in the
        // surface and look like swiss cheese.
        if (depth >= 8 && cav > 0.55) {
          t = TileType.CavernFloor;
        }
      }
      grid.setTile(x, y, t);
    }
  }

  // 4. Carve a starter pocket so the founders have somewhere to stand.
  // Sized for the seven founders plus a little working room. Per GDD §5.2 the
  // surface entrance is exposed; we extend a short corridor down into the
  // soil before opening into the chamber so the entrance reads as deliberate.
  const spawnX = Math.floor(width / 2);
  const spawnY = surfaceY[spawnX] + 2;

  // Surface clearing around the entrance: a flat shelf of Grass with a
  // scatter of Tree tiles. Gives the colony a visible source of wood
  // before the carpenter's workshop comes online. Flatten any terrain
  // above the spawn-row in this strip so the clearing reads as a
  // deliberate cleared area rather than a bumpy hillside.
  const clearY = surfaceY[spawnX];
  const clearHalf = 12;
  for (let dx = -clearHalf; dx <= clearHalf; dx++) {
    const cx = spawnX + dx;
    if (cx < 0 || cx >= width) continue;
    for (let y = 0; y < clearY; y++) grid.setTile(cx, y, TileType.Air);
    grid.setTile(cx, clearY, TileType.Grass);
  }
  // Trees: deterministic noise scatters them across the clearing.
  // Avoid placing one over the entrance shaft itself so dwarves can
  // descend cleanly without immediately tripping on a tree.
  const treeSeed = seed ^ 0x71ee_71ee;
  for (let dx = -clearHalf; dx <= clearHalf; dx++) {
    const cx = spawnX + dx;
    if (cx < 0 || cx >= width) continue;
    if (cx === spawnX || cx === spawnX + 1) continue;
    const n = noise2(treeSeed, cx * 0.45, 0);
    if (n > 0.25) {
      grid.setTile(cx, clearY, TileType.Tree);
    }
  }

  // Entrance shaft (a 2-wide stair down into the soil cap).
  carveRect(grid, spawnX, surfaceY[spawnX], 2, spawnY - surfaceY[spawnX] + 1, TileType.CorridorFloor);
  // Founders' chamber: 13×4 cavern just below.
  carveRect(grid, spawnX - 6, spawnY, 13, 4, TileType.CorridorFloor);

  return { grid, spawn: { x: spawnX, y: spawnY + 1 }, surfaceY };
}

function carveRect(grid: TileGrid, x0: number, y0: number, w: number, h: number, fill: TileType): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      grid.setTile(x, y, fill);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
