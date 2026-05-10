// A small ECS sized for session 1's needs but with room to grow. Each entity
// is identified by a 32-bit handle; components live in sparse-set stores so
// iteration over component owners is dense and cache-friendly. We never lean
// on Map/Set iteration order for simulation logic — sparse-set dense arrays
// are the canonical iteration source.

export type EntityId = number;

const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const GENERATION_SHIFT = INDEX_BITS;

export function entityIndex(e: EntityId): number {
  return e & INDEX_MASK;
}
export function entityGeneration(e: EntityId): number {
  return (e >>> GENERATION_SHIFT) & 0xfff;
}

export class ComponentStore<T> {
  // dense entity array; data array stays parallel.
  readonly entities: number[] = [];
  readonly data: T[] = [];
  // sparse[index] = position in dense array, or -1 if absent.
  readonly sparse: Int32Array;

  constructor(maxEntities: number) {
    this.sparse = new Int32Array(maxEntities);
    this.sparse.fill(-1);
  }

  has(e: EntityId): boolean {
    return this.sparse[entityIndex(e)] !== -1;
  }

  get(e: EntityId): T | undefined {
    const idx = this.sparse[entityIndex(e)];
    return idx === -1 ? undefined : this.data[idx];
  }

  set(e: EntityId, value: T): void {
    const i = entityIndex(e);
    const slot = this.sparse[i];
    if (slot === -1) {
      this.sparse[i] = this.entities.length;
      this.entities.push(e);
      this.data.push(value);
    } else {
      this.data[slot] = value;
    }
  }

  remove(e: EntityId): void {
    const i = entityIndex(e);
    const slot = this.sparse[i];
    if (slot === -1) return;
    const lastSlot = this.entities.length - 1;
    if (slot !== lastSlot) {
      const swapped = this.entities[lastSlot];
      this.entities[slot] = swapped;
      this.data[slot] = this.data[lastSlot];
      this.sparse[entityIndex(swapped)] = slot;
    }
    this.entities.pop();
    this.data.pop();
    this.sparse[i] = -1;
  }

  size(): number {
    return this.entities.length;
  }
}

/**
 * The ECS world. Entity creation/destruction and component access only.
 * Higher-level domain (`SimWorld`) wraps this with tile grid, RNG, jobs.
 */
export class EcsWorld {
  readonly maxEntities: number;
  // Per-entity generation counter; increments on destroy so dangling handles
  // can be detected.
  readonly generations: Uint16Array;
  private freeIndices: number[] = [];
  private nextIndex = 0;

  constructor(maxEntities = 4096) {
    this.maxEntities = maxEntities;
    this.generations = new Uint16Array(maxEntities);
  }

  create(): EntityId {
    const idx = this.freeIndices.length > 0 ? this.freeIndices.pop()! : this.nextIndex++;
    if (idx >= this.maxEntities) {
      throw new Error(`EcsWorld exceeded maxEntities=${this.maxEntities}`);
    }
    const gen = this.generations[idx];
    return ((gen << GENERATION_SHIFT) | idx) >>> 0;
  }

  /** Live entity count — used by SimWorld to apply graceful
   * backpressure on optional spawns (loose items) before the cap
   * is exceeded. */
  liveCount(): number {
    return this.nextIndex - this.freeIndices.length;
  }

  destroy(e: EntityId, stores: ComponentStore<unknown>[]): void {
    const idx = entityIndex(e);
    if (entityGeneration(e) !== this.generations[idx]) return;
    for (const s of stores) s.remove(e);
    this.generations[idx] = (this.generations[idx] + 1) & 0xfff;
    this.freeIndices.push(idx);
  }

  isAlive(e: EntityId): boolean {
    const idx = entityIndex(e);
    return idx < this.nextIndex && this.generations[idx] === entityGeneration(e);
  }
}
