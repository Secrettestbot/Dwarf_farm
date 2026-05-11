import { PALETTE } from "./palette";
import { TileType, TILE_INFO } from "../sim/world/tiles";

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
  [TileType.Door]: doorSprite(false),
  [TileType.DoorBarred]: doorSprite(true),
  [TileType.Grave]: gravePlotSprite(),
  [TileType.Headstone]: headstoneSprite(),
  [TileType.BrewingBarrel]: barrelSprite(),
  [TileType.Stove]: stoveSprite(),
  [TileType.Throne]: throneSprite(),
  [TileType.HospitalBed]: hospitalBedSprite(),
  [TileType.LibraryDesk]: libraryDeskSprite(),
  [TileType.ArmouryRack]: armouryRackSprite(),
  [TileType.WaterWheel]: waterWheelSprite(),
  [TileType.TradeScales]: tradeScalesSprite(),
  [TileType.PumpStation]: pumpStationSprite(),
  [TileType.TavernCounter]: tavernCounterSprite(),
  [TileType.ForgeStation]: anvilSprite("E"),
  [TileType.MagmaForgeStation]: anvilSprite("E"),
  [TileType.SmelterStation]: smelterStationSprite(),
  [TileType.MasonStation]: workbenchSprite("9"),
  [TileType.CarpenterStation]: workbenchSprite("6"),
  [TileType.JewellerStation]: jewellerStationSprite(),
  [TileType.KitchenStation]: stoveSprite(),
  [TileType.BreweryStation]: brewKettleSprite(),
  [TileType.KilnStation]: kilnStationSprite(),
  [TileType.TannerStation]: tanneryVatSprite(),
  [TileType.LoomStation]: loomFrameSprite(),
  [TileType.RawDiamond]: gemVeinSprite("B"),
  [TileType.RawRuby]: gemVeinSprite("E"),
  [TileType.RawEmerald]: gemVeinSprite("C"),
  [TileType.Gold]: oreVeinSprite("D"),
  [TileType.Silver]: oreVeinSprite("B"),
  [TileType.Coal]: oreVeinSprite("1"),
};

/** Wooden barrel: vertical cylinder with three iron hoops. */
function barrelSprite(): string[] {
  const base = noisyFill(3, 2);
  for (let y = 3; y <= 13; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) {
      const onEdge = x === 4 || x === 11 || y === 3 || y === 13;
      row = row.substring(0, x) + (onEdge ? "1" : "5") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Iron hoops at rows 5, 8, 11.
  for (const y of [5, 8, 11]) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) row = row.substring(0, x) + "1" + row.substring(x + 1);
    base[y] = row;
  }
  return base;
}

/** Stone stove / hearth: box with a glowing firebox and a chimney column. */
function stoveSprite(): string[] {
  const base = noisyFill(3, 2);
  // Body rows 5-13, cols 3-12. Dark stone outline + grey interior.
  for (let y = 5; y <= 13; y++) {
    let row = base[y];
    for (let x = 3; x <= 12; x++) {
      const onEdge = x === 3 || x === 12 || y === 5 || y === 13;
      row = row.substring(0, x) + (onEdge ? "1" : "9") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Firebox glow rows 9-11, cols 6-9.
  for (let y = 9; y <= 11; y++) {
    let row = base[y];
    for (let x = 6; x <= 9; x++) row = row.substring(0, x) + "E" + row.substring(x + 1);
    base[y] = row;
  }
  // Chimney column rows 1-4, col 7-8.
  for (let y = 1; y <= 4; y++) {
    let row = base[y];
    row = row.substring(0, 7) + "11" + row.substring(9);
    base[y] = row;
  }
  return base;
}

/** Throne: high-backed seat with regal accents. */
function throneSprite(): string[] {
  const base = noisyFill(3, 2);
  // High back rows 1-9, cols 4-11. Purple body, dark outline.
  for (let y = 1; y <= 9; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) {
      const onEdge = x === 4 || x === 11 || y === 1 || y === 9;
      row = row.substring(0, x) + (onEdge ? "1" : "F") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Seat rows 9-12, cols 2-13.
  for (let y = 9; y <= 12; y++) {
    let row = base[y];
    for (let x = 2; x <= 13; x++) {
      const onEdge = x === 2 || x === 13 || y === 12;
      row = row.substring(0, x) + (onEdge ? "1" : "F") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Gold trim at top of backrest.
  let row = base[2];
  for (let x = 5; x <= 10; x++) row = row.substring(0, x) + "D" + row.substring(x + 1);
  base[2] = row;
  return base;
}

/** Hospital cot: white bed with a red-cross. */
function hospitalBedSprite(): string[] {
  const base = noisyFill(3, 2);
  // Body rows 4-12, cols 2-13.
  for (let y = 4; y <= 12; y++) {
    let row = base[y];
    for (let x = 2; x <= 13; x++) {
      const onEdge = x === 2 || x === 13 || y === 4 || y === 12;
      row = row.substring(0, x) + (onEdge ? "1" : "B") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Red cross in the middle.
  base[7] = base[7].substring(0, 7) + "EE" + base[7].substring(9);
  base[8] = base[8].substring(0, 6) + "EEEE" + base[8].substring(10);
  base[9] = base[9].substring(0, 7) + "EE" + base[9].substring(9);
  return base;
}

/** Library desk: writing surface with a scroll/book on top. */
function libraryDeskSprite(): string[] {
  const base = noisyFill(3, 2);
  // Desktop rows 6-9, cols 1-14.
  for (let y = 6; y <= 9; y++) {
    let row = base[y];
    for (let x = 1; x <= 14; x++) {
      row = row.substring(0, x) + (y === 6 ? "6" : "5") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Legs rows 10-13.
  for (let y = 10; y <= 13; y++) {
    let row = base[y];
    row = row.substring(0, 2) + "1" + row.substring(3);
    row = row.substring(0, 13) + "1" + row.substring(14);
    base[y] = row;
  }
  // Open book / scroll on top — two pale rectangles.
  base[4] = base[4].substring(0, 5) + "BBBBBB" + base[4].substring(11);
  base[5] = base[5].substring(0, 5) + "B11BB1B" + base[5].substring(12);
  return base;
}

/** Armoury rack: vertical wood frame with weapons hung from it. */
function armouryRackSprite(): string[] {
  const base = noisyFill(3, 2);
  // Frame uprights cols 3 + 12, rows 2-13.
  for (let y = 2; y <= 13; y++) {
    let row = base[y];
    row = row.substring(0, 3) + "1" + row.substring(4);
    row = row.substring(0, 12) + "1" + row.substring(13);
    base[y] = row;
  }
  // Top + bottom rails rows 2, 13.
  for (const y of [2, 13]) {
    let row = base[y];
    for (let x = 3; x <= 12; x++) row = row.substring(0, x) + "1" + row.substring(x + 1);
    base[y] = row;
  }
  // Two weapons hanging: a sword (silver) and a pick (silver). Render
  // as vertical bars with brown grips.
  for (let y = 4; y <= 11; y++) {
    let row = base[y];
    row = row.substring(0, 6) + "B" + row.substring(7);
    row = row.substring(0, 9) + "B" + row.substring(10);
    base[y] = row;
  }
  base[4] = base[4].substring(0, 6) + "6" + base[4].substring(7);
  base[4] = base[4].substring(0, 9) + "6" + base[4].substring(10);
  return base;
}

/** Water wheel: large circular spoked wheel against a dark backdrop. */
function waterWheelSprite(): string[] {
  const base = noisyFill(2, 1);
  // Hub at centre col 7-8, row 7-8.
  base[7] = base[7].substring(0, 7) + "DD" + base[7].substring(9);
  base[8] = base[8].substring(0, 7) + "DD" + base[8].substring(9);
  // Rim — approximation of a circle radius 6.
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 5.5 && d < 7) {
        base[y] = base[y].substring(0, x) + "B" + base[y].substring(x + 1);
      }
    }
  }
  // Spokes — vertical, horizontal, and diagonals.
  for (let i = -5; i <= 5; i++) {
    const ax = Math.round(cx + i);
    const ay = Math.round(cy);
    base[ay] = base[ay].substring(0, ax) + "B" + base[ay].substring(ax + 1);
    const bx = Math.round(cx);
    const by = Math.round(cy + i);
    base[by] = base[by].substring(0, bx) + "B" + base[by].substring(bx + 1);
  }
  return base;
}

/** Trade scales: two pans on a beam. */
function tradeScalesSprite(): string[] {
  const base = noisyFill(3, 2);
  // Stand col 7-8, rows 5-13.
  for (let y = 5; y <= 13; y++) {
    let row = base[y];
    row = row.substring(0, 7) + "66" + row.substring(9);
    base[y] = row;
  }
  // Crossbar row 5, cols 2-13.
  let row = base[5];
  for (let x = 2; x <= 13; x++) row = row.substring(0, x) + "6" + row.substring(x + 1);
  base[5] = row;
  // Base row 13, cols 5-10.
  row = base[13];
  for (let x = 5; x <= 10; x++) row = row.substring(0, x) + "6" + row.substring(x + 1);
  base[13] = row;
  // Pans rows 6-8.
  for (let x = 1; x <= 4; x++) base[7] = base[7].substring(0, x) + "D" + base[7].substring(x + 1);
  for (let x = 11; x <= 14; x++) base[7] = base[7].substring(0, x) + "D" + base[7].substring(x + 1);
  return base;
}

/** Pump station: a vertical pipe with a hand crank on top. */
function pumpStationSprite(): string[] {
  const base = noisyFill(3, 2);
  // Pipe col 7-8, rows 3-13.
  for (let y = 3; y <= 13; y++) {
    let row = base[y];
    row = row.substring(0, 7) + "BB" + row.substring(9);
    base[y] = row;
  }
  // Crank handle row 2-3, cols 4-11.
  let r = base[2];
  for (let x = 4; x <= 11; x++) r = r.substring(0, x) + "1" + r.substring(x + 1);
  base[2] = r;
  // Flange row 13, cols 4-11.
  r = base[13];
  for (let x = 4; x <= 11; x++) r = r.substring(0, x) + "1" + r.substring(x + 1);
  base[13] = r;
  // Water drop at base.
  base[12] = base[12].substring(0, 7) + "FF" + base[12].substring(9);
  return base;
}

/** Tavern counter: low wooden bar with bottles. */
function tavernCounterSprite(): string[] {
  const base = noisyFill(3, 2);
  // Counter top rows 7-9, full width.
  for (let y = 7; y <= 9; y++) {
    let row = base[y];
    for (let x = 0; x < 16; x++) row = row.substring(0, x) + (y === 7 ? "6" : "5") + row.substring(x + 1);
    base[y] = row;
  }
  // Bottles on top — three small pips.
  base[5] = base[5].substring(0, 3) + "C" + base[5].substring(4);
  base[6] = base[6].substring(0, 3) + "C" + base[6].substring(4);
  base[5] = base[5].substring(0, 8) + "E" + base[5].substring(9);
  base[6] = base[6].substring(0, 8) + "E" + base[6].substring(9);
  base[5] = base[5].substring(0, 12) + "D" + base[5].substring(13);
  base[6] = base[6].substring(0, 12) + "D" + base[6].substring(13);
  return base;
}

/** Anvil sprite — black silhouette with optional glow underneath
 * (E = lava red) for the magma forge. Use any single-char palette
 * key for the glow colour. */
function anvilSprite(glowChar: string): string[] {
  const base = noisyFill(3, 2);
  // Anvil body — wide top, narrow waist, flared base.
  base[6] = base[6].substring(0, 2) + "111111111111" + base[6].substring(14);
  base[7] = base[7].substring(0, 2) + "1" + "AAAAAAAAAA" + "1" + base[7].substring(14);
  base[8] = base[8].substring(0, 4) + "11111111" + base[8].substring(12);
  base[9] = base[9].substring(0, 5) + "111111" + base[9].substring(11);
  base[10] = base[10].substring(0, 5) + "1AAAAA" + "1" + base[10].substring(12);
  base[11] = base[11].substring(0, 4) + "11111111" + base[11].substring(12);
  base[12] = base[12].substring(0, 3) + "1111111111" + base[12].substring(13);
  // Glow underneath for magma forge.
  if (glowChar === "E") {
    base[13] = base[13].substring(0, 4) + "EEEEEEEE" + base[13].substring(12);
  }
  return base;
}

/** Smelter station: stone furnace with a wide bottom and a chimney. */
function smelterStationSprite(): string[] {
  const base = noisyFill(3, 2);
  // Body rows 4-13.
  for (let y = 4; y <= 13; y++) {
    let row = base[y];
    for (let x = 2; x <= 13; x++) {
      const onEdge = x === 2 || x === 13 || y === 4 || y === 13;
      row = row.substring(0, x) + (onEdge ? "1" : "9") + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Glowing firebox rows 8-11, cols 6-9.
  for (let y = 8; y <= 11; y++) {
    let row = base[y];
    for (let x = 6; x <= 9; x++) row = row.substring(0, x) + "E" + row.substring(x + 1);
    base[y] = row;
  }
  // Chimney col 7-8, rows 1-3.
  for (let y = 1; y <= 3; y++) {
    let row = base[y];
    row = row.substring(0, 7) + "11" + row.substring(9);
    base[y] = row;
  }
  return base;
}

/** Workbench: a wooden bench with two legs and a small tool on top.
 * `topColorChar` selects the palette index for the top surface so we
 * can distinguish carpenter (wood) from mason (stone) at a glance. */
function workbenchSprite(topColorChar: string): string[] {
  const base = noisyFill(3, 2);
  // Top rows 6-7, cols 1-14.
  for (let y = 6; y <= 7; y++) {
    let row = base[y];
    for (let x = 1; x <= 14; x++) row = row.substring(0, x) + topColorChar + row.substring(x + 1);
    base[y] = row;
  }
  // Edge row 6 highlight.
  let row = base[6];
  for (let x = 1; x <= 14; x++) row = row.substring(0, x) + "6" + row.substring(x + 1);
  base[6] = row;
  // Legs rows 8-13 at cols 2 and 13.
  for (let y = 8; y <= 13; y++) {
    let r = base[y];
    r = r.substring(0, 2) + "1" + r.substring(3);
    r = r.substring(0, 13) + "1" + r.substring(14);
    base[y] = r;
  }
  // Small tool icon on top — a hammer outline.
  base[4] = base[4].substring(0, 6) + "111" + base[4].substring(9);
  base[5] = base[5].substring(0, 7) + "1" + base[5].substring(8);
  return base;
}

/** Jeweller's bench: small table with a glittering gem on top. */
function jewellerStationSprite(): string[] {
  const base = workbenchSprite("B");
  // Gem cluster — a few bright pips.
  base[4] = base[4].substring(0, 7) + "B" + base[4].substring(8);
  base[5] = base[5].substring(0, 6) + "BCB" + base[5].substring(9);
  base[3] = base[3].substring(0, 7) + "C" + base[3].substring(8);
  return base;
}

/** Brewer's kettle: round copper pot on a low fire. */
function brewKettleSprite(): string[] {
  const base = noisyFill(3, 2);
  // Kettle body rows 4-11.
  const cx = 7.5;
  const cy = 8;
  for (let y = 4; y <= 11; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 5) {
        base[y] = base[y].substring(0, x) + "6" + base[y].substring(x + 1);
      } else if (d < 5.8) {
        base[y] = base[y].substring(0, x) + "1" + base[y].substring(x + 1);
      }
    }
  }
  // Steam tendrils rows 0-3, top centre.
  base[2] = base[2].substring(0, 7) + "BB" + base[2].substring(9);
  base[1] = base[1].substring(0, 8) + "B" + base[1].substring(9);
  // Fire rows 12-13.
  base[12] = base[12].substring(0, 5) + "EEEEEE" + base[12].substring(11);
  base[13] = base[13].substring(0, 6) + "EDEE" + base[13].substring(10);
  return base;
}

/** Kiln: dome-shaped clay firing kiln with an opening. */
function kilnStationSprite(): string[] {
  const base = noisyFill(3, 2);
  const cx = 7.5;
  const cy = 9;
  for (let y = 4; y <= 13; y++) {
    for (let x = 1; x <= 14; x++) {
      const dx = x - cx;
      const dy = (y - cy) * 1.1;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 6 && y <= 13) {
        const onEdge = d > 5.3;
        base[y] = base[y].substring(0, x) + (onEdge ? "1" : "6") + base[y].substring(x + 1);
      }
    }
  }
  // Glowing opening rows 8-11, cols 6-9.
  for (let y = 8; y <= 11; y++) {
    let row = base[y];
    for (let x = 6; x <= 9; x++) row = row.substring(0, x) + "E" + row.substring(x + 1);
    base[y] = row;
  }
  return base;
}

/** Tannery vat: open wooden tub with a brownish liquid surface. */
function tanneryVatSprite(): string[] {
  const base = noisyFill(3, 2);
  for (let y = 5; y <= 13; y++) {
    let row = base[y];
    for (let x = 2; x <= 13; x++) {
      const onEdge = x === 2 || x === 13 || y === 13;
      const onTop = y === 5 && x > 2 && x < 13;
      row = row.substring(0, x) + (onEdge ? "1" : (onTop ? "1" : "4")) + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Tanning liquid in middle rows 7-12.
  for (let y = 7; y <= 12; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) row = row.substring(0, x) + "5" + row.substring(x + 1);
    base[y] = row;
  }
  return base;
}

/** Loom: vertical frame with strung warps. */
function loomFrameSprite(): string[] {
  const base = noisyFill(3, 2);
  // Uprights at cols 2 and 13.
  for (let y = 1; y <= 14; y++) {
    let row = base[y];
    row = row.substring(0, 2) + "6" + row.substring(3);
    row = row.substring(0, 13) + "6" + row.substring(14);
    base[y] = row;
  }
  // Top and bottom crossbars.
  for (const y of [1, 14]) {
    let row = base[y];
    for (let x = 2; x <= 13; x++) row = row.substring(0, x) + "6" + row.substring(x + 1);
    base[y] = row;
  }
  // Warp strings at cols 5, 8, 11.
  for (let y = 2; y <= 13; y++) {
    let row = base[y];
    for (const x of [5, 8, 11]) row = row.substring(0, x) + "B" + row.substring(x + 1);
    base[y] = row;
  }
  // Half-finished cloth panel rows 8-11.
  for (let y = 8; y <= 11; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) row = row.substring(0, x) + "D" + row.substring(x + 1);
    base[y] = row;
  }
  return base;
}

/** Gem-bearing ore vein in solid rock. Stone noise + a small cluster
 * of bright pips in the gem's colour. */
function gemVeinSprite(gemChar: string): string[] {
  const base = noisyFill(10, 8);
  const cluster: Array<[number, number]> = [
    [6, 6], [7, 6], [8, 7], [7, 8], [6, 9], [9, 8], [10, 9],
  ];
  for (const [x, y] of cluster) {
    base[y] = base[y].substring(0, x) + gemChar + base[y].substring(x + 1);
  }
  // A sparkle pip slightly off-cluster.
  base[4] = base[4].substring(0, 11) + "B" + base[4].substring(12);
  return base;
}

/** Metal / coal vein in solid rock — same noisy stone with a
 * scattering of brighter pips in the vein's colour. */
function oreVeinSprite(veinChar: string): string[] {
  const base = noisyFill(10, 8);
  const pips: Array<[number, number]> = [
    [3, 4], [4, 5], [11, 6], [10, 5], [7, 9], [13, 12], [5, 11], [12, 3],
  ];
  for (const [x, y] of pips) {
    base[y] = base[y].substring(0, x) + veinChar + base[y].substring(x + 1);
  }
  return base;
}

/** Empty grave plot — a darker patch of disturbed earth with a small
 * sunken outline. Reads as "ready for an interment". */
function gravePlotSprite(): string[] {
  const base = noisyFill(2, 3); // dark earth
  // Sunken rectangle in the middle.
  for (let y = 5; y <= 12; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) {
      const c = (y === 5 || y === 12 || x === 4 || x === 11) ? "1" : "2";
      row = row.substring(0, x) + c + row.substring(x + 1);
    }
    base[y] = row;
  }
  return base;
}

/** Headstone — an upright marker over an occupied plot. Stone slab
 * with a darker base, slightly weathered. */
function headstoneSprite(): string[] {
  const base = noisyFill(2, 3); // dark earth around it
  // Plot outline, like the empty grave.
  for (let y = 9; y <= 13; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) {
      const c = (y === 9 || y === 13 || x === 4 || x === 11) ? "1" : "2";
      row = row.substring(0, x) + c + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Headstone slab at top — rows 2-8, columns 6-9.
  for (let y = 2; y <= 8; y++) {
    let row = base[y];
    for (let x = 6; x <= 9; x++) {
      const c = (y === 2 || y === 8 || x === 6 || x === 9) ? "1" : "B";
      row = row.substring(0, x) + c + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Engraved cross-mark on the slab.
  base[5] = base[5].substring(0, 7) + "1" + base[5].substring(8);
  return base;
}

/** Door: a wooden plank silhouette with a small handle. Barred
 * version paints heavy reinforcement bars over the same plank shape
 * so the player can read the lockdown state at a glance. */
function doorSprite(barred: boolean): string[] {
  const base = noisyFill(3, 2);
  // Plank body: rows 1-14, cols 4-11.
  for (let y = 1; y <= 14; y++) {
    let row = base[y];
    for (let x = 4; x <= 11; x++) {
      const c = (y === 1 || y === 14) ? "1" : (x === 4 || x === 11) ? "1" : "5";
      row = row.substring(0, x) + c + row.substring(x + 1);
    }
    base[y] = row;
  }
  // Handle.
  base[8] = base[8].substring(0, 9) + "D" + base[8].substring(10);
  if (barred) {
    // Two heavy horizontal bars across the plank in dark grey.
    for (const yBar of [5, 10]) {
      let row = base[yBar];
      for (let x = 3; x <= 12; x++) {
        row = row.substring(0, x) + "8" + row.substring(x + 1);
      }
      base[yBar] = row;
    }
  }
  return base;
}

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
    const pixels = TILE_PIXELS[t];
    if (pixels) {
      s = paintFromRows(pixels);
    } else {
      // No hand-drawn sprite for this tile — paint a generic
      // "object on floor" silhouette in the tile's TILE_INFO colour.
      // Previously this branch returned a flat fill of palette index F
      // (clothes blue), which made every workshop / furniture / ore
      // tile read like a water tile.
      const info = TILE_INFO[t];
      s = procedurallyColoredSprite(info?.color ?? 0xa0a0a0, info?.walkable ?? false);
    }
    cache.set(key, s);
  }
  return s;
}

/** Procedural object-on-floor sprite tinted to `color`. Walkable
 * tiles (furniture / stations resting on a floor) get a base layer
 * of corridor-floor pattern with an object silhouette stamped on
 * top; solid tiles (ore veins, gem clusters, special rocks) fill
 * the whole sprite with the tile's colour plus a few sparkly
 * highlight specks so the deposit reads as embedded mineral. */
function procedurallyColoredSprite(
  color: number,
  walkable: boolean,
): HTMLCanvasElement | OffscreenCanvas {
  const surf = makeSurface();
  const ctx = (surf as HTMLCanvasElement).getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  const base = `#${color.toString(16).padStart(6, "0")}`;
  const dark = shadeColor(color, -0.4);
  const light = shadeColor(color, 0.3);
  if (!walkable) {
    // Solid: 2×2 textured fill so the tile reads as embedded
    // material, not a flat poster colour. A few specks add depth.
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const k = (x * 13 + y * 7 + x * y) & 15;
        ctx.fillStyle = k < 3 ? dark : base;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // Sparkly specks at fixed positions — a few brighter dots so
    // veins read as embedded minerals at a glance.
    ctx.fillStyle = light;
    for (const [x, y] of [[3, 4], [11, 6], [7, 9], [13, 12]]) {
      ctx.fillRect(x, y, 1, 1);
    }
    return surf;
  }
  // Walkable: paint a dark corridor-floor base + an object body
  // (rounded rectangle) in the tile's colour, with a dark outline
  // and a 1-pixel highlight along the top edge.
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const k = (x * 13 + y * 7 + x * y) & 15;
      // PALETTE[2] = dark earth, PALETTE[3] = earth shadow. Same
      // texture as CorridorFloor's noisyFill(3, 2).
      ctx.fillStyle = k < 3 ? PALETTE[2] : PALETTE[3];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // Object body: rectangle inset 3 pixels with a rounded silhouette.
  ctx.fillStyle = base;
  ctx.fillRect(3, 4, 10, 9);
  // Soft top edge highlight.
  ctx.fillStyle = light;
  ctx.fillRect(3, 4, 10, 1);
  ctx.fillRect(3, 5, 1, 7);
  // Bottom shadow.
  ctx.fillStyle = dark;
  ctx.fillRect(3, 12, 10, 1);
  ctx.fillRect(12, 5, 1, 7);
  // Dark outline corners so the silhouette pops on the dark floor.
  ctx.fillStyle = PALETTE[1];
  ctx.fillRect(2, 3, 12, 1);
  ctx.fillRect(2, 13, 12, 1);
  ctx.fillRect(2, 3, 1, 11);
  ctx.fillRect(13, 3, 1, 11);
  return surf;
}

/** Multiply each RGB channel by (1 + amount). Negative darkens. */
function shadeColor(color: number, amount: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const factor = 1 + amount;
  const rr = Math.max(0, Math.min(255, Math.round(r * factor)));
  const gg = Math.max(0, Math.min(255, Math.round(g * factor)));
  const bb = Math.max(0, Math.min(255, Math.round(b * factor)));
  return `rgb(${rr},${gg},${bb})`;
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

// Cave dog: low quadruped silhouette, dirt-brown body. Used for
// the pet system — wild and tame both render with this sprite,
// with a small claim pip overlaid in the renderer for tame pets.
const CAVE_DOG_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000111000",
  "00000111111144110",
  "0001144444444411",
  "0014444444444411",
  "0144444444444141",
  "1444444444444401",
  "1411111141111100",
  "0010100000110100",
  "0010100000110100",
  "0010000000010000",
  "0000000000000000",
];

// Cave falcon: wings spread, sharp profile in clothes-blue body
// with a dark beak. Distinct from the bat's chunkier silhouette so
// the two pets read at a glance.
const CAVE_FALCON_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0001100000011000",
  "0011510000015100",
  "0015511111155100",
  "0015555111555100",
  "0015555111155100",
  "0001515551111000",
  "0000115551100000",
  "0000011110000000",
  "0000010110000000",
  "0000010100000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
];

// Cave bat-as-pet: reuse the hostile bat sprite but tinted lighter.
const CAVE_BAT_PET_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0011000000001100",
  "0151100000011510",
  "0155100000015510",
  "0015510000155100",
  "0001551115551000",
  "0000155CCC100000",
  "0000015551000000",
  "0000001110000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
];

export function getPetSprite(kind: string): HTMLCanvasElement | OffscreenCanvas {
  const key = `pet:${kind}`;
  let s = cache.get(key);
  if (!s) {
    const rows =
      kind === "cave_falcon" ? CAVE_FALCON_PIXELS :
      kind === "cave_bat" ? CAVE_BAT_PET_PIXELS :
      CAVE_DOG_PIXELS;
    s = paintFromRows(rows);
    cache.set(key, s);
  }
  return s;
}

// Cave bat: small flying silhouette in dusk-purple wings.
const CAVE_BAT_PIXELS: string[] = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0011000000001100",
  "0151100000011510",
  "0155100000015510",
  "0015510000155100",
  "0001551115551000",
  "0000155555100000",
  "0000015551000000",
  "0000001110000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
];

// Giant spider: scaled cave spider, broader body, longer legs.
const GIANT_SPIDER_PIXELS: string[] = [
  "1000000000000001",
  "1100000000000011",
  "0110111111110110",
  "0010144444410100",
  "0101444444441010",
  "1014444444444101",
  "1014444444444101",
  "0114444444444110",
  "0114444554444110",
  "0114444554444110",
  "1014444444444101",
  "1014444444444101",
  "0101444444441010",
  "0010111111110100",
  "0110000000000110",
  "1100000000000011",
];

// Cave bear: hulking quadruped silhouette in dirt-brown.
const CAVE_BEAR_PIXELS: string[] = [
  "0000000000000000",
  "0000111000111000",
  "0001551001551000",
  "0001555111555000",
  "0011555555555100",
  "0155555555555510",
  "1555555555555551",
  "1555515555515551",
  "1555555555555551",
  "1555555555555551",
  "1555555555555551",
  "0155555555555510",
  "0115551111155110",
  "0011000000001100",
  "0010000000001000",
  "0000000000000000",
];

// Undead: gaunt humanoid silhouette in sickly green.
const UNDEAD_PIXELS: string[] = [
  "0000011111100000",
  "0000111CCC110000",
  "0001CCCCCCCC1000",
  "0001CCCCCCCC1000",
  "0011C1CCCC1CC100",
  "0001CCCCCCCC1000",
  "0001CCCCCCCC1000",
  "0001CC1CCCC11000",
  "0011CCCCCCCC1100",
  "01CCCCCCCCCCCC10",
  "01CCC1CCCCCC1C10",
  "0001CCCCCCCCC100",
  "0001CC11CC11C100",
  "0011C1001100C100",
  "0010100000110100",
  "0000000000000000",
];

// Fire imp: small clothes-red silhouette with flickering halo.
const FIRE_IMP_PIXELS: string[] = [
  "00000EEE00EEE000",
  "0000EEEE00EEEE00",
  "00000EE0000EE000",
  "0000111EE111E000",
  "00111EEEEEEE1100",
  "0111EEEEEEEEE110",
  "1EEEEEEEEEEEEEE1",
  "1EEEE111111EEEE1",
  "01EEEEEEEEEEEE10",
  "001EEEEEEEEE1100",
  "00111EEEEEE11000",
  "00011EEE1EEE1000",
  "0011001100110100",
  "0010001000010000",
  "0000000000000000",
  "0000000000000000",
];

// Automaton: blocky humanoid silhouette, stone-grey body, single
// glowing eye pixel.
const AUTOMATON_PIXELS: string[] = [
  "0000111111110000",
  "0001999999991000",
  "0011999999999100",
  "0119999E9E99991",
  "1199999999999911",
  "1199911111119911",
  "1199900099009911",
  "1199900099009911",
  "1199911111119911",
  "1199999999999911",
  "0119999999999110",
  "0011199999991100",
  "0001199009990100",
  "0001199009990100",
  "0011199001199100",
  "0011000001100000",
];

const HOSTILE_PIXELS: Record<string, string[]> = {
  cave_rat: CAVE_RAT_PIXELS,
  cave_bat: CAVE_BAT_PIXELS,
  cave_spider: CAVE_SPIDER_PIXELS,
  giant_spider: GIANT_SPIDER_PIXELS,
  cave_bear: CAVE_BEAR_PIXELS,
  goblin_scout: GOBLIN_SCOUT_PIXELS,
  cave_troll: CAVE_TROLL_PIXELS,
  undead: UNDEAD_PIXELS,
  fire_imp: FIRE_IMP_PIXELS,
  automaton: AUTOMATON_PIXELS,
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
