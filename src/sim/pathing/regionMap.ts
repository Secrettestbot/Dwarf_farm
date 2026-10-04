// Coarse-grained connectivity cache for hierarchical pathfinding.
//
// Full HPA* (chunk + portal + abstract A*) is a multi-week feature.
// What lands here is the part that matters most for the 400×2000
// world: a region map that fast-fails A* calls whose start and goal
// lie in disconnected regions, so the colony doesn't burn 6000-node
// searches for every unreachable target.
//
// Algorithm:
//   1. Label every walkable tile with a region id by flood-fill
//      (8-connected, matching the A* movement model, including its
//      no-corner-cutting rule).
//   2. Two tiles share a region iff they're connected through
//      walkable space — A* between them will succeed.
//
// The map updates lazily: callers mark it dirty when walkable space
// changes (a wall is mined, a corridor floods, a door bars) and the
// next query brings it up to date. Updates are incremental where that
// is exact:
//   - Per-chunk tile versions (TileGrid.chunkVersion) say which chunks
//     changed since the last update; only those are re-read into the
//     walkability snapshot.
//   - If every walkability change since the last update was a tile
//     *becoming* walkable (mining — by far the common case), each new
//     tile gets a fresh label that is union-find-merged with its
//     walkable neighbours. That yields exactly the connectivity a full
//     flood-fill would: any move a new tile enables either starts/ends
//     on it, or is a diagonal it unblocks as a corner — and both ends
//     of such a diagonal are orthogonal neighbours of the new tile, so
//     they are merged through it anyway.
//   - Any tile becoming non-walkable (barred door, flooding) can split
//     a region, so that falls back to the full O(W·H) flood-fill.
// Region ids are only meaningful for equality (connected()); the
// numeric values differ between the incremental and full paths.

import { CHUNK_SIZE, TileGrid } from "../world/grid";
import { tileWalkable } from "../world/tiles";

/** 32×32 chunks. Smaller chunks give more granular fast-fails but a
 * heavier rebuild; 32 is a comfortable balance for the 400×2000
 * world (≈ 12×62 chunk grid). */
export const REGION_CHUNK = 32;
void REGION_CHUNK;

export class RegionMap {
  private readonly width: number;
  private readonly height: number;
  /** One region label per tile. 0 = solid/non-walkable. Real labels
   * start at 1; the region is find(label). */
  private readonly regionOf: Int32Array;
  /** Union-find parent per label (index = label). */
  private parent: number[] = [0];
  private dirty = true;
  private built = false;
  private regionCount = 0;
  /** Flat per-tile walkability as of the last update. */
  private readonly walk: Uint8Array;
  /** TileGrid chunk versions as of the last update (-1 = never read). */
  private chunkSeen: Float64Array | null = null;
  /** BFS queue for full rebuilds, allocated once (a fresh one per
   * rebuild cost 3.2 MB on the full 400×2000 world). */
  private queue: Int32Array | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.regionOf = new Int32Array(width * height);
    this.walk = new Uint8Array(width * height);
  }

  /** Mark the map for update on the next query. Cheap — just sets a
   * flag. Caller is responsible for calling this whenever walkable
   * space changes (mining a tile, flooding a corridor, barring a
   * door). The next A* call drives the actual recompute. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Return the region id for (x, y), or 0 if non-walkable / OOB.
   * Cells with the same non-zero id are mutually reachable. */
  regionAt(grid: TileGrid, x: number, y: number): number {
    if (this.dirty) this.update(grid);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const label = this.regionOf[y * this.width + x];
    return label === 0 ? 0 : this.find(label);
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

  private find(label: number): number {
    const parent = this.parent;
    while (parent[label] !== label) {
      parent[label] = parent[parent[label]];
      label = parent[label];
    }
    return label;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic: the smaller root wins.
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
    this.regionCount--;
  }

  private update(grid: TileGrid): void {
    const w = this.width;
    const walk = this.walk;
    const nChunks = grid.chunksX * grid.chunksY;
    if (!this.chunkSeen || this.chunkSeen.length !== nChunks) {
      this.chunkSeen = new Float64Array(nChunks).fill(-1);
    }
    const chunkSeen = this.chunkSeen;
    // Re-read changed chunks into the walkability snapshot, noting
    // which tiles became walkable and whether any became blocked.
    const opened: number[] = [];
    let closed = false;
    for (let cy = 0; cy < grid.chunksY; cy++) {
      for (let cx = 0; cx < grid.chunksX; cx++) {
        const ci = cy * grid.chunksX + cx;
        const ver = grid.chunkVersion(cx, cy);
        if (chunkSeen[ci] === ver) continue;
        chunkSeen[ci] = ver;
        const tiles = grid.rawChunk(cx, cy).tiles;
        const gx0 = cx * CHUNK_SIZE;
        const gy0 = cy * CHUNK_SIZE;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          const rowSrc = ly * CHUNK_SIZE;
          const rowDst = (gy0 + ly) * w + gx0;
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const nv = WALKABLE_LUT[tiles[rowSrc + lx]];
            const di = rowDst + lx;
            if (nv === walk[di]) continue;
            walk[di] = nv;
            if (!nv) closed = true;
            else if (this.built) opened.push(di);
          }
        }
      }
    }
    if (!this.built || closed) {
      this.rebuild();
    } else {
      for (let k = 0; k < opened.length; k++) this.addWalkable(opened[k]);
    }
    this.dirty = false;
  }

  /** Give a newly walkable tile its own label and merge it with every
   * walkable neighbour it can step to under A*'s movement rule.
   * Neighbours that are themselves new but not yet labelled are
   * skipped; they merge back when their own turn comes (the rule is
   * symmetric). */
  private addWalkable(idx: number): void {
    const w = this.width;
    const h = this.height;
    const walk = this.walk;
    const label = this.parent.length;
    this.parent.push(label);
    this.regionCount++;
    this.regionOf[idx] = label;
    const cx = idx % w;
    const cy = (idx / w) | 0;
    for (let i = 0; i < 8; i++) {
      const nx = cx + REGION_DX[i];
      const ny = cy + REGION_DY[i];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (!walk[nIdx]) continue;
      if (i >= 4) {
        if (!walk[cy * w + nx]) continue;
        if (!walk[ny * w + cx]) continue;
      }
      const nl = this.regionOf[nIdx];
      if (nl !== 0) this.union(label, nl);
    }
  }

  /** Full flood-fill relabel from the walkability snapshot. */
  private rebuild(): void {
    const w = this.width;
    const h = this.height;
    const walk = this.walk;
    this.regionOf.fill(0);
    let nextId = 0;
    const queue = (this.queue ??= new Int32Array(w * h));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!walk[y * w + x]) continue;
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
            if (!walk[nIdx]) continue;
            // Block diagonals through solid corners — must match A*'s
            // movement rule so the region map agrees with the planner.
            // (nx, cy) and (cx, ny) are in bounds: nx/ny were checked.
            if (i >= 4) {
              if (!walk[cy * w + nx]) continue;
              if (!walk[ny * w + cx]) continue;
            }
            this.regionOf[nIdx] = nextId;
            queue[tail++] = nIdx;
          }
        }
      }
    }
    this.parent = new Array<number>(nextId + 1);
    for (let i = 0; i <= nextId; i++) this.parent[i] = i;
    this.regionCount = nextId;
    this.built = true;
  }
}

/** tileWalkable() for every possible tile byte. */
const WALKABLE_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let t = 0; t < 256; t++) lut[t] = tileWalkable(t) ? 1 : 0;
  return lut;
})();

const REGION_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const REGION_DY = [0, 0, 1, -1, 1, -1, 1, -1];
