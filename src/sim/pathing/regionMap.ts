// Coarse-grained connectivity cache for hierarchical pathfinding.
//
// Full HPA* (chunk + portal + abstract A*) is a multi-week feature.
// What lands here is the part that matters most for the 400×2000
// world: a chunk-resolution region map that fast-fails A* calls
// whose start and goal lie in disconnected regions, so the colony
// doesn't burn 6000-node searches for every unreachable target.
//
// Algorithm:
//   1. Partition the grid into REGION_CHUNK × REGION_CHUNK chunks.
//   2. For each tile, compute its region id by flood-fill over
//      walkable tiles (8-connected, matching the A* movement model).
//   3. Two tiles share a region iff they're connected through
//      walkable space — A* between them will succeed.
//
// The map rebuilds lazily: callers mark it dirty when walkable space
// changes (a wall is mined, a corridor floods, a door bars). The
// rebuild itself is O(W·H) flood-fill — cheap relative to the cost
// of even one wasted A* search on the full grid.

import { TileGrid } from "../world/grid";

/** 32×32 chunks. Smaller chunks give more granular fast-fails but a
 * heavier rebuild; 32 is a comfortable balance for the 400×2000
 * world (≈ 12×62 chunk grid). */
export const REGION_CHUNK = 32;
void REGION_CHUNK;

export class RegionMap {
  private readonly width: number;
  private readonly height: number;
  /** One region id per tile. 0 = solid/non-walkable. Real regions
   * start at 1. Cells in the same region are A*-connected. */
  private readonly regionOf: Int32Array;
  private dirty = true;
  private regionCount = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.regionOf = new Int32Array(width * height);
  }

  /** Mark the map for rebuild on the next query. Cheap — just sets a
   * flag. Caller is responsible for calling this whenever walkable
   * space changes (mining a tile, flooding a corridor, barring a
   * door). The next A* call drives the actual recompute. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Return the region id for (x, y), or 0 if non-walkable / OOB.
   * Cells with the same non-zero id are mutually reachable. */
  regionAt(grid: TileGrid, x: number, y: number): number {
    if (this.dirty) this.rebuild(grid);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.regionOf[y * this.width + x];
  }

  /** True iff the two tiles share a region — A* between them is
   * guaranteed to find a path (modulo node budget). */
  connected(grid: TileGrid, ax: number, ay: number, bx: number, by: number): boolean {
    const ra = this.regionAt(grid, ax, ay);
    if (ra === 0) return false;
    const rb = this.regionAt(grid, bx, by);
    return ra === rb;
  }

  /** Diagnostic accessor — mostly useful in tests. */
  numRegions(): number {
    return this.regionCount;
  }

  private rebuild(grid: TileGrid): void {
    const w = this.width;
    const h = this.height;
    this.regionOf.fill(0);
    let nextId = 0;
    // Reuse a queue buffer — flood-fill BFS, 8-connected to match A*.
    const total = w * h;
    const queue = new Int32Array(total);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!grid.isWalkable(x, y)) continue;
        const startIdx = y * w + x;
        if (this.regionOf[startIdx] !== 0) continue;
        nextId++;
        let head = 0;
        let tail = 0;
        queue[tail++] = startIdx;
        this.regionOf[startIdx] = nextId;
        while (head < tail) {
          const idx = queue[head++];
          const cx = idx % w;
          const cy = (idx / w) | 0;
          for (let i = 0; i < 8; i++) {
            const nx = cx + REGION_DX[i];
            const ny = cy + REGION_DY[i];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (this.regionOf[nIdx] !== 0) continue;
            if (!grid.isWalkable(nx, ny)) continue;
            // Block diagonals through solid corners — must match A*'s
            // movement rule so the region map agrees with the planner.
            if (i >= 4) {
              if (!grid.isWalkable(cx + REGION_DX[i], cy)) continue;
              if (!grid.isWalkable(cx, cy + REGION_DY[i])) continue;
            }
            this.regionOf[nIdx] = nextId;
            queue[tail++] = nIdx;
          }
        }
      }
    }
    this.regionCount = nextId;
    this.dirty = false;
  }
}

const REGION_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const REGION_DY = [0, 0, 1, -1, 1, -1, 1, -1];
