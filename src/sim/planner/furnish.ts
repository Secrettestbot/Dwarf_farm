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
import { Blueprint } from "./blueprint";

export function furnishRoom(grid: TileGrid, b: Blueprint): void {
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
    // Corridors, mines, and stairwells stay bare — they're passages or
    // active workspaces, not rooms. Real ore mines later get an extraction
    // marker; for now leaving them as plain CorridorFloor.
    default:
      break;
  }
}

/** Farm: every cavity cell becomes a FarmTile. The farm production
 * system runs over these to deliver food to the stockpile. */
function furnishFarm(grid: TileGrid, b: Blueprint): void {
  for (let i = 0; i < b.cavity.length; i++) {
    const c = b.cavity[i];
    const x = c & 0xffff;
    const y = (c >>> 16) & 0xffff;
    grid.setTile(x, y, TileType.FarmTile);
  }
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
