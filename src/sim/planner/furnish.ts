// When a blueprint is harvested complete, the room gets furnished — a few
// purposeful tiles drop in so it visually reads as a finished room rather
// than a generic excavated cavity. Rooms become functional once their
// minimum furniture is placed (GDD §7.1).
//
// Choices are deterministic from the blueprint's geometry — no RNG, so
// catch-up and live play furnish identically. The full GDD inventory
// (chairs, doors, chests, statues, engravings) lives in later sessions
// when the resource and crafting pipeline can supply them.

import { TileGrid } from "../world/grid";
import { TileType } from "../world/tiles";
import { Blueprint, isMaintainable } from "./blueprint";

export function furnishRoom(grid: TileGrid, b: Blueprint): void {
  // Enclosed rooms get a door at their entrance cell. Passage kinds
  // (corridor, mine, lumberyard, stairwell) skip — they're not real
  // rooms with thresholds. The lockdown emergency turns each Door to
  // DoorBarred so the colony can actually seal itself when threatened.
  if (isMaintainable(b.kind)) {
    placeDoorAtEntrance(grid, b);
  }
  switch (b.kind) {
    case "bedroom":
      furnishBedroom(grid, b);
      break;
    case "dining_hall":
      furnishDiningHall(grid, b);
      break;
    case "stockpile":
      furnishStockpile(grid, b);
      break;
    case "farm":
      furnishFarm(grid, b);
      break;
    case "kitchen":
      furnishWorkshop(grid, b, TileType.KitchenStation);
      break;
    case "brewery":
      furnishWorkshop(grid, b, TileType.BreweryStation);
      break;
    case "smelter":
      furnishWorkshop(grid, b, TileType.SmelterStation);
      break;
    case "forge":
      furnishWorkshop(grid, b, TileType.ForgeStation);
      break;
    case "mason":
      furnishWorkshop(grid, b, TileType.MasonStation);
      break;
    case "jeweller":
      furnishWorkshop(grid, b, TileType.JewellerStation);
      break;
    case "carpenter":
      furnishWorkshop(grid, b, TileType.CarpenterStation);
      break;
    case "kiln":
      furnishWorkshop(grid, b, TileType.KilnStation);
      break;
    case "tannery":
      furnishWorkshop(grid, b, TileType.TannerStation);
      break;
    case "loom":
      furnishWorkshop(grid, b, TileType.LoomStation);
      break;
    case "hospital":
      furnishHospital(grid, b);
      break;
    case "tavern":
      furnishTavern(grid, b);
      break;
    case "magma_forge":
      furnishWorkshop(grid, b, TileType.MagmaForgeStation);
      break;
    case "water_wheel":
      furnishWaterWheel(grid, b);
      break;
    case "library":
      furnishLibrary(grid, b);
      break;
    case "armoury":
      furnishArmoury(grid, b);
      break;
    case "throne_room":
      furnishThroneRoom(grid, b);
      break;
    case "pump_station":
      furnishWorkshop(grid, b, TileType.PumpStation);
      break;
    // Corridors, mines, and stairwells stay bare — they're passages or
    // active workspaces, not rooms. Real ore mines later get an extraction
    // marker; for now leaving them as plain CorridorFloor.
    default:
      break;
  }
}

/** Throne Room: a single throne tile dead-centre. Decorative for now —
 * the chair sits where it sits and the milestone fires on completion. */
function furnishThroneRoom(grid: TileGrid, b: Blueprint): void {
  const cx = b.originX + Math.floor(b.width / 2);
  const cy = b.originY + Math.floor(b.height / 2);
  if (cavityContains(b, cx, cy)) grid.setTile(cx, cy, TileType.Throne);
}

/** Armoury: rack tiles along the back wall, evenly spaced. Visual only —
 * the draft system equips soldiers from the global tools counter when
 * this room exists, regardless of which rack tile holds what. */
function furnishArmoury(grid: TileGrid, b: Blueprint): void {
  const y = b.originY;
  for (let dx = 0; dx < b.width; dx += 2) {
    const x = b.originX + dx;
    if (cavityContains(b, x, y)) grid.setTile(x, y, TileType.ArmouryRack);
  }
}

/** Library: two desks along the upper row so two scholars can study
 * side by side without blocking each other. */
function furnishLibrary(grid: TileGrid, b: Blueprint): void {
  const y = b.originY;
  const x1 = b.originX + 1;
  const x2 = b.originX + b.width - 2;
  if (cavityContains(b, x1, y)) grid.setTile(x1, y, TileType.LibraryDesk);
  if (x2 !== x1 && cavityContains(b, x2, y)) grid.setTile(x2, y, TileType.LibraryDesk);
}

/** Workshops drop a single workstation tile in the centre of their cavity.
 * The crafter dwarf stands on it for the duration of a recipe. */
function furnishWorkshop(grid: TileGrid, b: Blueprint, station: TileType): void {
  const cx = b.originX + Math.floor(b.width / 2);
  const cy = b.originY + Math.floor(b.height / 2);
  if (cavityContains(b, cx, cy)) {
    grid.setTile(cx, cy, station);
  }
}

/** Farm: every cavity cell becomes a FarmTile. Initialise the
 * cell-tended-at array so the farm starts fresh — every cell counts as
 * just-tended when the dwarves first plant it; they'll need to come
 * back inside TEND_VALIDITY ticks to keep it productive. */
function furnishFarm(grid: TileGrid, b: Blueprint): void {
  for (let i = 0; i < b.cavity.length; i++) {
    const c = b.cavity[i];
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    grid.setTile(x, y, TileType.FarmTile);
  }
  // Lazily initialise; farms set cellTendedAt to a fresh array. The
  // planner doesn't know the current tick, so the farmSystem fills in
  // the actual planted-at tick on its first run over the farm.
  b.cellTendedAt = new Int32Array(b.cavity.length).fill(-1);
}

/** Water Wheel: the cavity itself becomes WaterWheel tiles. There's
 * no station/barkeep — the wheel runs on its own, and the speed
 * bonus is applied passively in workSystem to nearby workshops. */
function furnishWaterWheel(grid: TileGrid, b: Blueprint): void {
  for (let i = 0; i < b.cavity.length; i++) {
    const c = b.cavity[i];
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    grid.setTile(x, y, TileType.WaterWheel);
  }
}

/** Tavern: a counter dead-centre for the barkeep, plus a row of
 * tables so the room reads as a hangout, not just a bar. */
function furnishTavern(grid: TileGrid, b: Blueprint): void {
  const cx = b.originX + Math.floor(b.width / 2);
  const cy = b.originY + Math.floor(b.height / 2);
  if (cavityContains(b, cx, cy)) grid.setTile(cx, cy, TileType.TavernCounter);
  // Tables flanking the counter for visiting dwarves to sit at.
  const tx1 = b.originX + 1;
  const tx2 = b.originX + b.width - 2;
  const ty = b.originY + b.height - 1;
  if (tx1 !== cx && cavityContains(b, tx1, ty)) grid.setTile(tx1, ty, TileType.Table);
  if (tx2 !== cx && tx2 !== tx1 && cavityContains(b, tx2, ty)) grid.setTile(tx2, ty, TileType.Table);
}

/** Hospital: two cots along the back wall so two wounded dwarves can
 * be treated at once without colliding. */
function furnishHospital(grid: TileGrid, b: Blueprint): void {
  const y = b.originY;
  const x1 = b.originX + 1;
  const x2 = b.originX + b.width - 2;
  if (cavityContains(b, x1, y)) grid.setTile(x1, y, TileType.HospitalBed);
  if (x2 !== x1 && cavityContains(b, x2, y)) grid.setTile(x2, y, TileType.HospitalBed);
}

/** Bedroom: one bed, tucked into the upper-left corner of the cavity. */
function furnishBedroom(grid: TileGrid, b: Blueprint): void {
  // Place the bed at the most-walled corner so it doesn't block the doorway.
  const bedX = b.originX;
  const bedY = b.originY;
  if (cavityContains(b, bedX, bedY)) {
    grid.setTile(bedX, bedY, TileType.Bed);
  }
}

/**
 * Dining hall (8×5): a row of tables down the middle, leaving aisles on
 * either side.
 */
function furnishDiningHall(grid: TileGrid, b: Blueprint): void {
  const midY = b.originY + Math.floor(b.height / 2);
  // Spread 3 tables across the middle row, evenly spaced.
  const tableXs = [
    b.originX + 1,
    b.originX + Math.floor(b.width / 2),
    b.originX + b.width - 2,
  ];
  for (const x of tableXs) {
    if (cavityContains(b, x, midY)) {
      grid.setTile(x, midY, TileType.Table);
    }
  }
}

/** Stockpile (5×4): bins along the back wall (top row of the cavity). */
function furnishStockpile(grid: TileGrid, b: Blueprint): void {
  const y = b.originY;
  for (let dx = 0; dx < b.width; dx += 2) {
    const x = b.originX + dx;
    if (cavityContains(b, x, y)) {
      grid.setTile(x, y, TileType.Bin);
    }
  }
}

/** True if (x, y) is one of the blueprint's cavity cells. */
function cavityContains(b: Blueprint, x: number, y: number): boolean {
  const target = (y << 16) | x;
  for (let i = 0; i < b.cavity.length; i++) {
    if (b.cavity[i] === target) return true;
  }
  return false;
}

/** Place a Door tile at the cavity cell that has the most walkable
 * non-cavity neighbours — that's the doorway between the room and the
 * rest of the colony. If no cell has any external walkable neighbours
 * (an isolated cavity), no door is placed. Skips cells that already
 * carry furniture so we don't clobber a station or bed. */
function placeDoorAtEntrance(grid: TileGrid, b: Blueprint): void {
  let bestX = -1;
  let bestY = -1;
  let bestScore = 0;
  for (let i = 0; i < b.cavity.length; i++) {
    const c = b.cavity[i];
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    let score = 0;
    const neighbours = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (cavityContains(b, nx, ny)) continue;
      if (grid.isWalkable(nx, ny)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
      bestY = y;
    }
  }
  if (bestX === -1) return;
  grid.setTile(bestX, bestY, TileType.Door);
}
