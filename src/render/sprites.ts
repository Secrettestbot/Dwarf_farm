import { PALETTE } from "./palette";
import { TileType } from "../sim/world/tiles";

// All sprites are drawn into 16×16 OffscreenCanvases (or HTMLCanvasElement
// fallback) and cached. Pixel data is described as 16-row strings of palette
// indices in hex (0–9 then A–F).

const SPRITE_SIZE = 16;
const cache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

function makeSurface(): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(SPRITE_SIZE, SPRITE_SIZE);
  }
  const c = document.createElement("canvas");
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  return c;
}

function paintFromRows(rows: string[]): HTMLCanvasElement | OffscreenCanvas {
  const surf = makeSurface();
  const ctx = (surf as HTMLCanvasElement).getContext("2d", { willReadFrequently: false }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;
  // Fill transparent.
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const c = row[x];
      if (!c || c === "0" || c === ".") continue;
      const idx = parseInt(c, 16);
      const colour = PALETTE[idx];
      if (!colour || colour === "transparent") continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return surf;
}

// Tile sprite definitions. Pixel grid: '.' / '0' = transparent, hex digit =
// palette index. 16 rows × 16 cols.
const TILE_PIXELS: Partial<Record<TileType, string[]>> = {
  [TileType.Air]: rep("0", 16, 16),
  [TileType.Dirt]: noisyFill(5, 4),
  [TileType.Sand]: noisyFill(7, 6),
  [TileType.Stone]: noisyFill(10, 8),
  [TileType.Granite]: noisyFill(9, 8),
  [TileType.Ore]: noisyFillWithSpecks(6, 4, 12),
  [TileType.CavernFloor]: noisyFill(2, 1),
  [TileType.CorridorFloor]: noisyFill(3, 2),
  [TileType.Water]: rep("F", 16, 16, "F"),
  [TileType.Lava]: rep("E", 16, 16, "E"),
  [TileType.Designated]: digOverlay(),
  [TileType.Bed]: bedSprite(),
  [TileType.Table]: tableSprite(),
  [TileType.Bin]: binSprite(),
  [TileType.Memorial]: memorialSprite(),
  [TileType.FarmTile]: farmSprite(),
  [TileType.Grass]: grassSprite(),
  [TileType.Tree]: treeSprite(),
};

/** Surface grass: green-tinted earth dotted with brighter sprout pixels.
 * Distinct from the dirt cap so the player can read where the colony's
 * outdoor clearing ends. */
function grassSprite(): string[] {
  const base = noisyFill(2, 4); // dark earth + soil
  const sprouts: Array<[number, number]> = [
    [2, 3], [6, 5], [11, 4], [14, 7], [4, 9], [9, 11], [13, 13], [3, 14],
  ];
  for (const [x, y] of sprouts) {
    base[y] = base[y].substring(0, x) + "C" + base[y].substring(x + 1);
  }
  return base;
}

/** Surface tree: brown trunk centred under a green canopy. Eight rows
 * of dappled foliage, four of bark — the kind of pixel-tree silhouette
 * a sawyer aims their axe at. */
function treeSprite(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      // Canopy: a fat ellipse from row 0 to 9 covering most columns.
      const cx = 7.5;
      const cy = 4.5;
      const dx = (x - cx) / 7;
      const dy = (y - cy) / 4.5;
      const inCanopy = dx * dx + dy * dy < 1;
      // Trunk: 2 cols wide at rows 9-15.
      const inTrunk = y >= 9 && (x === 7 || x === 8);
      if (inTrunk) {
        row += y === 15 ? "1" : "5"; // dirt-brown trunk; dark base
      } else if (inCanopy) {
        // Speckled canopy: alternate sprout green and granite-shadow for
        // depth.
        const k = (x * 5 + y * 3) & 7;
        row += k < 2 ? "1" : "C";
      } else {
        row += "0";
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Farm: dark tilled-soil base with bright green crop tufts and dark
 * furrow lines, deliberately distinct from plain dirt at the surface. */
function farmSprite(): string[] {
  // Use a darker tilled-soil base than dirt's noisy brown so the contrast
  // with the surface Skin layer reads from the minimap and the renderer.
  const base = noisyFill(2, 3); // dark earth + earth shadow
  // Bright green crop tufts (palette index C = sprout green) in a 3×3
  // regular grid with the centre tufts reaching one row taller so they
  // read as actual plants instead of dots.
  const tufts: Array<[number, number]> = [
    [3, 4],  [8, 4],  [13, 4],
    [3, 9],  [8, 9],  [13, 9],
    [3, 14], [8, 14], [13, 14],
  ];
  for (const [x, y] of tufts) {
    let row = base[y];
    row = row.substring(0, x) + "C" + row.substring(x + 1);
    base[y] = row;
    // Stem one row above each tuft.
    if (y - 1 >= 0) {
      let above = base[y - 1];
      above = above.substring(0, x) + "C" + above.substring(x + 1);
      base[y - 1] = above;
    }
  }
  // Dark furrow lines between rows so the soil reads as tilled.
  for (const yLine of [6, 11]) {
    let row = "";
    for (let x = 0; x < 16; x++) row += "1"; // near-black
    base[yLine] = row;
  }
  return base;
}

/** Memorial: a small upright stone marker (cairn) on the corridor floor. */
function memorialSprite(): string[] {
  const base = noisyFill(3, 2);
  // Pillar at columns 6-9, rows 4-13.
  for (let y = 4; y <= 13; y++) {
    let row = base[y];
    for (let x = 6; x <= 9; x++) {
      // Light at row 4 (top), darker midbody, darkest base.
      let c = "9"; // granite
      if (y === 4) c = "B"; // top highlight
      else if (y >= 11) c = "8"; // shadow base
      row = row.substring(0, x) + c + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Cap row at row 3 — slightly wider top.
  let cap = base[3];
  for (let x = 5; x <= 10; x++) cap = cap.substring(0, x) + "B" + cap.substring(x + 1);
  base[3] = cap;
  // Single warm-glow pixel at row 6 — uses blonde-gold so it reads as
  // candlelight on the cairn even after palette index 12 was repurposed
  // for sprout green (used by farms).
  base[6] = base[6].substring(0, 7) + "D" + base[6].substring(8);
  return base;
}

/** Bed: dark wood frame, red mattress on top of corridor-floor base. */
function bedSprite(): string[] {
  const base = noisyFill(3, 2); // corridor floor base color
  // Frame at rows 5-12, mattress at rows 6-9.
  for (let y = 5; y <= 12; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      if (x < 2 || x > 13) {
        row += base[y][x];
      } else if (y === 5 || y === 12) {
        row += "1"; // dark frame top/bottom
      } else if (x === 2 || x === 13) {
        row += "1"; // dark frame sides
      } else if (y >= 6 && y <= 9) {
        row += "E"; // red mattress (palette 14 = clothes red, but using E as bright accent)
      } else {
        row += "5"; // pillow / blanket lower (dirt brown)
      }
    }
    base[y] = row;
  }
  // Pillow indicator: a small lighter spot at the head.
  base[6] = base[6].substring(0, 3) + "DD" + base[6].substring(5);
  base[7] = base[7].substring(0, 3) + "DD" + base[7].substring(5);
  return base;
}

/** Table: square wooden top with darker legs. */
function tableSprite(): string[] {
  const base = noisyFill(3, 2);
  // Top at rows 5-9, columns 2-13.
  for (let y = 5; y <= 9; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      if (x >= 2 && x <= 13) row += "5"; // wood top
      else row += base[y][x];
    }
    base[y] = row;
  }
  // Edge highlight at row 5.
  base[5] = base[5].substring(0, 2) + "6666666666" + "66" + base[5].substring(14);
  // Legs at rows 10-13, columns 3 + 12.
  for (let y = 10; y <= 13; y++) {
    let row = base[y];
    row = row.substring(0, 3) + "1" + row.substring(4);
    row = row.substring(0, 12) + "1" + row.substring(13);
    base[y] = row;
  }
  return base;
}

/** Bin: a small box on the floor. */
function binSprite(): string[] {
  const base = noisyFill(3, 2);
  // Box at rows 4-13, cols 3-12.
  for (let y = 4; y <= 13; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      if (x < 3 || x > 12) {
        row += base[y][x];
      } else if (y === 4 || y === 13 || x === 3 || x === 12) {
        row += "1"; // dark frame
      } else {
        row += "4"; // soil-brown contents
      }
    }
    base[y] = row;
  }
  // Lid line at row 6.
  base[6] = base[6].substring(0, 4) + "11111111" + base[6].substring(12);
  return base;
}

function rep(c: string, w: number, h: number, _alt?: string): string[] {
  const row = c.repeat(w);
  return new Array(h).fill(row);
}

// Pseudo-deterministic per-tile-type texture: alternates two palette indices
// in a 4×4 pattern with one specked pixel.
function noisyFill(primary: number, accent: number): string[] {
  const p = primary.toString(16).toUpperCase();
  const a = accent.toString(16).toUpperCase();
  const out: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      const k = (x * 13 + y * 7 + x * y) & 15;
      row += k < 3 ? a : p;
    }
    out.push(row);
  }
  return out;
}

function noisyFillWithSpecks(primary: number, accent: number, speck: number): string[] {
  const base = noisyFill(primary, accent);
  const s = speck.toString(16).toUpperCase();
  const out = base.slice();
  // Drop a few sparkly pixels for ore.
  const spots = [
    [3, 4],
    [11, 6],
    [7, 9],
    [13, 12],
  ];
  for (const [x, y] of spots) {
    out[y] = out[y].substring(0, x) + s + out[y].substring(x + 1);
  }
  return out;
}

function digOverlay(): string[] {
  // A subtle blonde-gold X overlay; rendered atop the tile beneath it in
  // the renderer. (Was index 12 before that slot became sprout green.)
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      const onDiag = x === y || x === 15 - y;
      row += onDiag ? "D" : "0";
    }
    rows.push(row);
  }
  return rows;
}

export function getTileSprite(t: TileType): HTMLCanvasElement | OffscreenCanvas {
  const key = `t:${t}`;
  let s = cache.get(key);
  if (!s) {
    s = paintFromRows(TILE_PIXELS[t] ?? rep("F", 16, 16, "F"));
    cache.set(key, s);
  }
  return s;
}

// ---- Layer-aware tinting -----------------------------------------------
// Per GDD §11.3 the palette shifts cooler as the colony descends, with each
// geological band feeling visually distinct. We pre-tint the base tile
// sprites per layer once and cache them; the renderer picks the right
// variant based on the tile's depth relative to the surface.

/** Per-layer multiplicative RGB tint. Layer 0 (Skin) is the native palette. */
export const LAYER_TINTS: Array<[number, number, number]> = [
  [1.00, 1.00, 1.00], // 0 Skin — surface browns, no tint
  [0.86, 0.92, 1.00], // 1 Shallow Earth — slightly cool grey
  [0.72, 0.80, 0.98], // 2 Deep Rock — cool grey-blue
  [1.00, 0.84, 0.62], // 3 Gem Seam — amber/magma cast
  [0.42, 0.48, 0.66], // 4 Ancient Dark — deep blue-black
  [1.00, 0.58, 0.52], // 5 Underworld — red-shifted
];

/** Layer index (0..5) for a given y, given a reference surface y. */
export function layerOf(y: number, surfaceY: number): number {
  const depth = y - surfaceY;
  if (depth < 80) return 0;
  if (depth < 300) return 1;
  if (depth < 700) return 2;
  if (depth < 1200) return 3;
  if (depth < 1600) return 4;
  return 5;
}

function tintSprite(
  base: HTMLCanvasElement | OffscreenCanvas,
  tint: [number, number, number],
): HTMLCanvasElement | OffscreenCanvas {
  const surf = makeSurface();
  const ctx = (surf as HTMLCanvasElement).getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  // 1) Paint the base sprite.
  ctx.drawImage(base as CanvasImageSource, 0, 0);
  // 2) Multiply by the tint colour. This darkens / shifts opaque pixels;
  //    transparent areas would also pick up the tint, so we mask in (3).
  ctx.globalCompositeOperation = "multiply";
  const r = Math.round(tint[0] * 255);
  const g = Math.round(tint[1] * 255);
  const b = Math.round(tint[2] * 255);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  // 3) Re-mask alpha against the original sprite so transparent pixels
  //    stay transparent rather than showing the multiply fill colour.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(base as CanvasImageSource, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return surf;
}

/** Tile sprite tinted for the given layer. Layer 0 returns the base sprite. */
export function getTileSpriteAtLayer(
  t: TileType,
  layer: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (layer === 0) return getTileSprite(t);
  const key = `t:${t}:L${layer}`;
  let s = cache.get(key);
  if (!s) {
    const base = getTileSprite(t);
    s = tintSprite(base, LAYER_TINTS[layer] ?? LAYER_TINTS[0]);
    cache.set(key, s);
  }
  return s;
}

// Dwarf sprite — all dwarves share one base sprite for session 1 (variation
// added in session 2 once they have personalities). 8×16, centred in 16×16.
const DWARF_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "00000DDDDD000000",
  "0000DD22322DD000",
  "000D2444444220D0",
  "00D24444444422D0",
  "0DD2D4444442DDD0",
  "0DDDDDDDDDDDDDDD".slice(0, 16),
  "00FF14444411FF00",
  "00FF14444411FF00",
  "00FF14444411FF00",
  "00FE11111111EF00",
  "0001111111111100",
  "0001111000111100",
  "0011110000011100",
  "0001100000001100",
];

export function getDwarfSprite(): HTMLCanvasElement | OffscreenCanvas {
  const key = "dwarf:default";
  let s = cache.get(key);
  if (!s) {
    s = paintFromRows(DWARF_PIXELS);
    cache.set(key, s);
  }
  return s;
}

// Hostile pixel art. Each row uses palette indices (0 = transparent);
// 1 = dark outline, the body uses kind-specific palette slots.

// Cave rat: small, low to the ground, palette-red (E = blonde).
const CAVE_RAT_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "00000111000000",
  "0000111E1100000",
  "00011EEEE110000",
  "00111EEEEEE1000",
  "01EEEEEEEEEE100",
  "0011EEEEEE1100".slice(0, 16),
  "00011111111100",
  "0010100110010000",
  "0010100110010000",
  "0000000000000000",
  "0000000000000000",
];

// Cave spider: eight legs, low body, palette-purple-ish (5 = dusk).
const CAVE_SPIDER_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0001000000010000",
  "0010111111100000",
  "0010155555100100",
  "0101555555510010",
  "0105555555550010",
  "1015555555510100",
  "0115555555511000",
  "0010111111100000",
  "0001000000010000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
];

// Goblin scout: humanoid silhouette, palette-green (A = sprout).
const GOBLIN_SCOUT_PIXELS: string[] = [
  "0000000000000000",
  "0000001111000000",
  "0000011AA1100000",
  "0000011AA1100000",
  "0000011AA1100000",
  "0000111AA1110000",
  "0001AAAAAAAA1000",
  "0001AAAAAAAA1000",
  "0001AAAAAAAA1000",
  "0001AAAAAAAA1000",
  "0001AAAAAAAA1000",
  "0001A11AA11A1000",
  "0001A1100AA1A100",
  "0011A1000AA1A100",
  "0010100000110000",
  "0000000000000000",
];

// Cave troll: hulking, slow, palette-grey-blue (4 = dusk).
const CAVE_TROLL_PIXELS: string[] = [
  "0000111111100000",
  "0001144444411000",
  "0011144444441100",
  "0011144444441100",
  "0001144444411000",
  "0011144444441100",
  "0114444444444110",
  "1444444444444441",
  "1444444444444441",
  "1444444444444441",
  "1444444444444441",
  "0144444444444410",
  "0114111111141100",
  "0011100000111000",
  "0010000000001000",
  "0000000000000000",
];

// Void shade: tall, dark, and wrong — the King's emissary. Palette
// 5 = dusk-purple, 1 = outline. Asymmetric outline so it reads as
// not-quite-stable.
const VOID_SHADE_PIXELS: string[] = [
  "0001000000010000",
  "0011000000110000",
  "0151100001151000",
  "0155100001551000",
  "0155551115551000",
  "0155555555551000",
  "0155555555551000",
  "0015555555510000",
  "0015555555510000",
  "0001555555100000",
  "0001515551500000",
  "0001150511500000",
  "0001100110010000",
  "0001000000010000",
  "0010000000010000",
  "0000000000000000",
];

// The Hollow King: hulking, crowned, and wrong. Fills almost the
// entire 16×16 cell — palette 5 = dusk-purple body, 9 = wine for the
// crown's accent, 1 = dark outline.
const HOLLOW_KING_PIXELS: string[] = [
  "0001500000510000",
  "0015190000915100",
  "0015999999951500",
  "0015999999951500",
  "0115555555555110",
  "1555555555555551",
  "1559155555515951",
  "1559155555515951",
  "1555555555555551",
  "1555515555155551",
  "1555599999955551",
  "0155555555555510",
  "0015551115555100",
  "0001550000551000",
  "0001100000110000",
  "0010000000010000",
];

const HOSTILE_PIXELS: Record<string, string[]> = {
  cave_rat: CAVE_RAT_PIXELS,
  cave_spider: CAVE_SPIDER_PIXELS,
  goblin_scout: GOBLIN_SCOUT_PIXELS,
  cave_troll: CAVE_TROLL_PIXELS,
  void_shade: VOID_SHADE_PIXELS,
  hollow_king: HOLLOW_KING_PIXELS,
};

export function getHostileSprite(kind: string): HTMLCanvasElement | OffscreenCanvas {
  const key = `hostile:${kind}`;
  let s = cache.get(key);
  if (!s) {
    const rows = HOSTILE_PIXELS[kind] ?? CAVE_RAT_PIXELS;
    s = paintFromRows(rows);
    cache.set(key, s);
  }
  return s;
}

export const SPRITE_TILE_SIZE = SPRITE_SIZE;
