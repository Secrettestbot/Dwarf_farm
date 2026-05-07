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
const TILE_PIXELS: Record<TileType, string[]> = {
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
};

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
  // A subtle yellow X overlay; rendered atop the tile beneath it in the renderer.
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      const onDiag = x === y || x === 15 - y;
      row += onDiag ? "C" : "0";
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

export const SPRITE_TILE_SIZE = SPRITE_SIZE;
