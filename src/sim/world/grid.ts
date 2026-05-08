import { TileType, tileWalkable, tileSolid } from "./tiles";

export const CHUNK_SIZE = 100;

export class Chunk {
  readonly tiles: Uint8Array;
  // Designation flags per-tile. Bit 0 = inside a Dig Zone.
  readonly designation: Uint8Array;
  /** Fog-of-war: 0 = never seen, 1 = seen by a dwarf. Once flipped to 1
   * stays at 1 (revealed terrain doesn't re-fog). The renderer reads this
   * and draws unseen tiles as opaque dark blocks. */
  readonly seen: Uint8Array;
  dirty = true;

  constructor() {
    this.tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    this.designation = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    this.seen = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  }
}

/**
 * 2D tile grid divided into 100×100 chunks. Tile coordinates are in tiles, not
 * pixels. `width` and `height` must be multiples of CHUNK_SIZE.
 */
export class TileGrid {
  readonly width: number;
  readonly height: number;
  readonly chunksX: number;
  readonly chunksY: number;
  private readonly chunks: Chunk[];

  constructor(width: number, height: number) {
    if (width % CHUNK_SIZE !== 0 || height % CHUNK_SIZE !== 0) {
      throw new Error(`grid dimensions must be multiples of ${CHUNK_SIZE}`);
    }
    this.width = width;
    this.height = height;
    this.chunksX = width / CHUNK_SIZE;
    this.chunksY = height / CHUNK_SIZE;
    const total = this.chunksX * this.chunksY;
    this.chunks = new Array(total);
    for (let i = 0; i < total; i++) this.chunks[i] = new Chunk();
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private chunkAt(x: number, y: number): Chunk {
    const cx = (x / CHUNK_SIZE) | 0;
    const cy = (y / CHUNK_SIZE) | 0;
    return this.chunks[cy * this.chunksX + cx];
  }

  private localIndex(x: number, y: number): number {
    return (y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE);
  }

  getTile(x: number, y: number): number {
    if (!this.inBounds(x, y)) return TileType.Granite;
    return this.chunkAt(x, y).tiles[this.localIndex(x, y)];
  }

  setTile(x: number, y: number, t: number): void {
    if (!this.inBounds(x, y)) return;
    const c = this.chunkAt(x, y);
    c.tiles[this.localIndex(x, y)] = t;
    c.dirty = true;
  }

  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return tileWalkable(this.getTile(x, y));
  }

  isSolid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return tileSolid(this.getTile(x, y));
  }

  isSeen(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.chunkAt(x, y).seen[this.localIndex(x, y)] !== 0;
  }

  markSeen(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const c = this.chunkAt(x, y);
    const idx = this.localIndex(x, y);
    if (c.seen[idx] === 0) {
      c.seen[idx] = 1;
      c.dirty = true;
    }
  }

  getDesignation(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.chunkAt(x, y).designation[this.localIndex(x, y)];
  }

  setDesignation(x: number, y: number, flags: number): void {
    if (!this.inBounds(x, y)) return;
    const c = this.chunkAt(x, y);
    c.designation[this.localIndex(x, y)] = flags;
    c.dirty = true;
  }

  /** Iterate all chunks (for save/render iteration). */
  eachChunk(fn: (chunk: Chunk, cx: number, cy: number) => void): void {
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        fn(this.chunks[cy * this.chunksX + cx], cx, cy);
      }
    }
  }

  /** Read-only access to raw chunk tile array (for renderers/codecs). */
  rawChunk(cx: number, cy: number): Chunk {
    return this.chunks[cy * this.chunksX + cx];
  }

  markAllDirty(): void {
    for (const c of this.chunks) c.dirty = true;
  }
}
