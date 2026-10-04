// Sim-side emergency behaviour (GDD §4.3): Safe Zone selection,
// shelter spots, and the Lockdown perimeter seal. The mode itself is
// toggled by the UI; emergencySystem in sim.ts reacts to transitions.

import { Blueprint, BlueprintKind, unpackCellX, unpackCellY } from "../planner/blueprint";
import { TileType } from "../world/tiles";
import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";

/** Room kinds that count as shelter. Open workings (mines, farms,
 * corridors, shafts) and the surface-facing depot don't. */
const SHELTER_KINDS: ReadonlySet<BlueprintKind> = new Set<BlueprintKind>([
  "bedroom",
  "dining_hall",
  "stockpile",
  "kitchen",
  "brewery",
  "hospital",
  "library",
  "tavern",
  "armoury",
  "throne_room",
  "great_hall",
]);

function walkableCells(sim: SimWorld, b: Blueprint): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < b.cavity.length; i++) {
    const x = unpackCellX(b.cavity[i]);
    const y = unpackCellY(b.cavity[i]);
    if (sim.grid.isWalkable(x, y)) out.push({ x, y });
  }
  return out;
}

/** Pick the Safe Zone: the deepest finished shelter room that is
 * reachable from the entrance, preferring rooms with a door and more
 * floor space. Returns the blueprint, or null to fall back to the
 * entrance. */
export function chooseSafeZone(sim: SimWorld): Blueprint | null {
  let best: Blueprint | null = null;
  let bestScore = -Infinity;
  for (const b of sim.planner.blueprints) {
    if (b.status !== "complete" || !SHELTER_KINDS.has(b.kind)) continue;
    const cells = walkableCells(sim, b);
    if (cells.length === 0) continue;
    if (!sim.regions.connected(sim.grid, sim.spawn.x, sim.spawn.y, cells[0].x, cells[0].y)) continue;
    const hasDoor = cells.some((c) => sim.grid.getTile(c.x, c.y) === TileType.Door);
    const depth = b.originY + b.height / 2;
    const score = depth + (hasDoor ? 20 : 0) + Math.min(cells.length, 30) * 0.5;
    if (score > bestScore || (score === bestScore && best && b.id < best.id)) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

/** Where a sheltering dwarf should stand. Spreads the colony over the
 * Safe Zone's floor (by entity id) so they don't all queue for one
 * tile; falls back to the entrance. */
export function shelterSpotFor(sim: SimWorld, e: EntityId): { x: number; y: number } {
  const id = sim.emergency.safeZoneId ?? -1;
  if (id >= 0) {
    const b = sim.planner.blueprints.find((bp) => bp.id === id);
    if (b) {
      const cells = walkableCells(sim, b);
      if (cells.length > 0) return cells[e % cells.length];
    }
  }
  return { x: sim.spawn.x, y: sim.spawn.y };
}

/** True when (x, y) is walkable ground on (or above) the surface —
 * surfaceY is the grass row dwarves walk on outside. */
function isSurfaceOpen(sim: SimWorld, x: number, y: number): boolean {
  if (x < 0 || x >= sim.grid.width) return false;
  return y <= sim.surfaceY[x] && sim.grid.isWalkable(x, y);
}

/** Seal every underground walkable tile (below the grass row) that
 * opens directly onto the surface — the tops of entrance shafts. Internal doors are left alone. Returns packed
 * [x, y, originalTile] triples for restoreSeal. */
export function sealPerimeter(sim: SimWorld): number[] {
  const sealed: number[] = [];
  const grid = sim.grid;
  let minS = Infinity;
  let maxS = -Infinity;
  for (let x = 0; x < grid.width; x++) {
    minS = Math.min(minS, sim.surfaceY[x]);
    maxS = Math.max(maxS, sim.surfaceY[x]);
  }
  // Only rows around the surface line can border open sky.
  for (let y = Math.max(0, minS - 1); y <= Math.min(grid.height - 1, maxS + 1); y++) {
    for (let x = 0; x < grid.width; x++) {
      if (y <= sim.surfaceY[x]) continue; // the surface itself
      if (!grid.isWalkable(x, y)) continue;
      if (
        isSurfaceOpen(sim, x, y - 1) ||
        isSurfaceOpen(sim, x - 1, y) ||
        isSurfaceOpen(sim, x + 1, y)
      ) {
        sealed.push(x, y, grid.getTile(x, y));
      }
    }
  }
  for (let i = 0; i < sealed.length; i += 3) grid.setTile(sealed[i], sealed[i + 1], TileType.DoorBarred);
  if (sealed.length > 0) sim.regions.invalidate();
  return sealed;
}

/** Undo sealPerimeter. Also clears any stray barred doors left by
 * older saves, where Lockdown barred every door in the fortress. */
export function restoreSeal(sim: SimWorld, sealed: number[] | undefined): void {
  const grid = sim.grid;
  let changed = false;
  const restored = new Set<number>();
  if (sealed) {
    for (let i = 0; i + 2 < sealed.length; i += 3) {
      const x = sealed[i];
      const y = sealed[i + 1];
      if (grid.getTile(x, y) === TileType.DoorBarred) {
        grid.setTile(x, y, sealed[i + 2]);
        changed = true;
      }
      restored.add(y * grid.width + x);
    }
  }
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.getTile(x, y) === TileType.DoorBarred && !restored.has(y * grid.width + x)) {
        grid.setTile(x, y, TileType.Door);
        changed = true;
      }
    }
  }
  if (changed) sim.regions.invalidate();
}
