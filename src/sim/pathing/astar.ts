import { TileGrid } from "../world/grid";
import { RegionMap } from "./regionMap";

// 8-connected A* with octile heuristic. All buffers preallocated and reused
// across calls — `findPath` is allocation-free in the hot path.
//
// Hierarchical fast-fail: when a RegionMap is supplied, A* checks
// chunk-resolution connectivity first and returns null immediately for
// goals in a disconnected region. This is the main performance win on
// the 400×2000 world — the colony stops burning 6000-node searches on
// targets behind unmined rock.

const CARDINAL_COST = 10;
const DIAGONAL_COST = 14;
const NEIGHBORS_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBORS_DY = [0, 0, 1, -1, 1, -1, 1, -1];
const NEIGHBORS_COST = [
  CARDINAL_COST,
  CARDINAL_COST,
  CARDINAL_COST,
  CARDINAL_COST,
  DIAGONAL_COST,
  DIAGONAL_COST,
  DIAGONAL_COST,
  DIAGONAL_COST,
];

export class AStar {
  private readonly width: number;
  private readonly height: number;
  private readonly gScore: Float64Array;
  private readonly fScore: Float64Array;
  private readonly cameFrom: Int32Array;
  private readonly visitedGen: Int32Array;
  private readonly closedGen: Int32Array;
  private generation = 0;

  // Binary min-heap of cell indices, keyed on fScore. Capacity grows on demand.
  private heap: Int32Array;
  private heapSize = 0;

  /** Optional region map — when set, findPath fast-fails on
   * disconnected goals before running the heap-based search. */
  regions: RegionMap | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const total = width * height;
    this.gScore = new Float64Array(total);
    this.fScore = new Float64Array(total);
    this.cameFrom = new Int32Array(total);
    this.visitedGen = new Int32Array(total);
    this.closedGen = new Int32Array(total);
    this.heap = new Int32Array(1024);
  }

  /**
   * Find a path from (sx, sy) to (gx, gy) through walkable tiles only.
   * Returns a packed Int32Array of cells (origin included) or null if no path
   * exists or maxNodes was exceeded.
   */
  findPath(grid: TileGrid, sx: number, sy: number, gx: number, gy: number, maxNodes = 6000): Int32Array | null {
    if (!grid.isWalkable(sx, sy)) return null;
    if (!grid.isWalkable(gx, gy)) return null;
    if (sx === gx && sy === gy) {
      const out = new Int32Array(1);
      out[0] = (sy << 16) | sx;
      return out;
    }
    // Hierarchical fast-fail: if start and goal lie in disconnected
    // regions of walkable space, no A* search will find a path. The
    // region map is much cheaper to consult than running 6000 nodes
    // of A* only to time out.
    if (this.regions && !this.regions.connected(grid, sx, sy, gx, gy)) {
      return null;
    }
    this.generation = (this.generation + 1) | 0;
    if (this.generation === 0) this.generation = 1;
    this.heapSize = 0;

    const w = this.width;
    const startIdx = sy * w + sx;
    const goalIdx = gy * w + gx;
    this.gScore[startIdx] = 0;
    this.fScore[startIdx] = octile(sx, sy, gx, gy);
    this.visitedGen[startIdx] = this.generation;
    this.heapPush(startIdx);

    let visited = 0;
    while (this.heapSize > 0) {
      const current = this.heapPop();
      // Older heap entry from a decrease-key push — already processed.
      if (this.closedGen[current] === this.generation) continue;
      if (current === goalIdx) {
        return this.reconstruct(current, startIdx);
      }
      this.closedGen[current] = this.generation;
      const cx = current % w;
      const cy = (current / w) | 0;
      const baseG = this.gScore[current];

      for (let i = 0; i < 8; i++) {
        const nx = cx + NEIGHBORS_DX[i];
        const ny = cy + NEIGHBORS_DY[i];
        if (nx < 0 || ny < 0 || nx >= w || ny >= this.height) continue;
        if (!grid.isWalkable(nx, ny)) continue;
        // Block diagonal squeezes through solid corners.
        if (i >= 4) {
          if (!grid.isWalkable(cx + NEIGHBORS_DX[i], cy)) continue;
          if (!grid.isWalkable(cx, cy + NEIGHBORS_DY[i])) continue;
        }
        const nIdx = ny * w + nx;
        if (this.closedGen[nIdx] === this.generation) continue;
        const tentativeG = baseG + NEIGHBORS_COST[i];
        if (this.visitedGen[nIdx] !== this.generation || tentativeG < this.gScore[nIdx]) {
          this.cameFrom[nIdx] = current;
          this.gScore[nIdx] = tentativeG;
          this.fScore[nIdx] = tentativeG + octile(nx, ny, gx, gy);
          this.visitedGen[nIdx] = this.generation;
          // Decrease-key implemented as push-duplicate; stale copies filtered
          // at pop time via the closedGen guard above.
          this.heapPush(nIdx);
        }
      }

      visited++;
      if (visited > maxNodes) return null;
    }
    return null;
  }

  /**
   * Pathfind to any walkable neighbor of a (typically solid) target tile.
   * Returns the path including the chosen approach tile as its last cell.
   */
  findPathToNeighbor(
    grid: TileGrid,
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    maxNodes = 6000,
  ): Int32Array | null {
    let best: Int32Array | null = null;
    let bestLen = Infinity;
    for (let i = 0; i < 8; i++) {
      const nx = tx + NEIGHBORS_DX[i];
      const ny = ty + NEIGHBORS_DY[i];
      if (!grid.isWalkable(nx, ny)) continue;
      const path = this.findPath(grid, sx, sy, nx, ny, maxNodes);
      if (path && path.length < bestLen) {
        best = path;
        bestLen = path.length;
      }
    }
    return best;
  }

  private reconstruct(end: number, start: number): Int32Array {
    // Walk parents back to start to count length.
    let len = 1;
    let n = end;
    while (n !== start) {
      n = this.cameFrom[n];
      len++;
    }
    const w = this.width;
    const out = new Int32Array(len);
    n = end;
    for (let i = len - 1; i >= 0; i--) {
      const x = n % w;
      const y = (n / w) | 0;
      out[i] = (y << 16) | x;
      if (n !== start) n = this.cameFrom[n];
    }
    return out;
  }

  private heapPush(idx: number): void {
    if (this.heapSize >= this.heap.length) {
      const grown = new Int32Array(this.heap.length * 2);
      grown.set(this.heap);
      this.heap = grown;
    }
    this.heap[this.heapSize++] = idx;
    this.siftUp(this.heapSize - 1);
  }

  private heapPop(): number {
    const top = this.heap[0];
    this.heapSize--;
    if (this.heapSize > 0) {
      this.heap[0] = this.heap[this.heapSize];
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    const fScore = this.fScore;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fScore[heap[i]] < fScore[heap[parent]]) {
        const tmp = heap[i];
        heap[i] = heap[parent];
        heap[parent] = tmp;
        i = parent;
      } else break;
    }
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const fScore = this.fScore;
    const n = this.heapSize;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && fScore[heap[l]] < fScore[heap[smallest]]) smallest = l;
      if (r < n && fScore[heap[r]] < fScore[heap[smallest]]) smallest = r;
      if (smallest === i) break;
      const tmp = heap[i];
      heap[i] = heap[smallest];
      heap[smallest] = tmp;
      i = smallest;
    }
  }
}

function octile(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x0 - x1);
  const dy = Math.abs(y0 - y1);
  return CARDINAL_COST * (dx + dy) + (DIAGONAL_COST - 2 * CARDINAL_COST) * Math.min(dx, dy);
}

export function unpackCell(cell: number): { x: number; y: number } {
  return { x: cell & 0xffff, y: (cell >>> 16) & 0xffff };
}
