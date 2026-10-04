// Player-painted zones (GDD §4.2). The player's only spatial input:
// coarse rectangles that bias where dwarves work. Dwarves still decide
// for themselves when and who.
//
// - Dig: dwarves excavate every reachable solid tile inside the zone, at
//   their own pace (alongside the Architect's own blueprints).
// - Forbidden: dwarves never path through or work inside the zone. A
//   dwarf already inside may still walk out.
// - Gather: haulers clear loose items from the zone before others.
//
// The rectangle list is the saved state; a per-tile bitmask is derived
// from it for O(1) lookups in hot paths (A*, mine-target BFS, hauling).

export type ZoneKind = "dig" | "forbidden" | "gather";

export interface Zone {
  id: number;
  kind: ZoneKind;
  /** Inclusive tile bounds. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const ZONE_BITS: Record<ZoneKind, number> = {
  dig: 1,
  forbidden: 2,
  gather: 4,
};

/** Hard cap so a runaway painter can't bloat saves. */
export const MAX_ZONES = 64;

export class ZoneMap {
  readonly width: number;
  readonly height: number;
  /** Per-tile OR of ZONE_BITS, rebuilt whenever the zone list changes. */
  readonly mask: Uint8Array;
  private list: Zone[] = [];
  private nextId = 1;
  private counts: Record<ZoneKind, number> = { dig: 0, forbidden: 0, gather: 0 };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.mask = new Uint8Array(width * height);
  }

  get zones(): ReadonlyArray<Zone> {
    return this.list;
  }

  /** Add a zone from two corner tiles (any order), clamped to the
   * world. Returns the new zone, or null at the cap. */
  add(kind: ZoneKind, ax: number, ay: number, bx: number, by: number): Zone | null {
    if (this.list.length >= MAX_ZONES) return null;
    const clampX = (v: number) => Math.max(0, Math.min(this.width - 1, Math.floor(v)));
    const clampY = (v: number) => Math.max(0, Math.min(this.height - 1, Math.floor(v)));
    const zone: Zone = {
      id: this.nextId++,
      kind,
      x0: clampX(Math.min(ax, bx)),
      y0: clampY(Math.min(ay, by)),
      x1: clampX(Math.max(ax, bx)),
      y1: clampY(Math.max(ay, by)),
    };
    this.list.push(zone);
    this.rebuild();
    return zone;
  }

  /** Remove every zone covering (x, y). Returns how many were removed. */
  removeAt(x: number, y: number): number {
    const before = this.list.length;
    this.list = this.list.filter((z) => !(x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1));
    if (this.list.length !== before) this.rebuild();
    return before - this.list.length;
  }

  clear(): void {
    this.list = [];
    this.rebuild();
  }

  /** Replace the zone list (save restore). */
  load(zones: ReadonlyArray<Omit<Zone, "id">>): void {
    this.list = [];
    this.nextId = 1;
    for (const z of zones.slice(0, MAX_ZONES)) {
      this.list.push({ ...z, id: this.nextId++ });
    }
    this.rebuild();
  }

  has(kind: ZoneKind, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return (this.mask[y * this.width + x] & ZONE_BITS[kind]) !== 0;
  }

  isForbidden(x: number, y: number): boolean {
    return this.has("forbidden", x, y);
  }

  any(kind: ZoneKind): boolean {
    return this.counts[kind] > 0;
  }

  private rebuild(): void {
    this.mask.fill(0);
    this.counts = { dig: 0, forbidden: 0, gather: 0 };
    for (const z of this.list) {
      this.counts[z.kind]++;
      const bit = ZONE_BITS[z.kind];
      for (let y = z.y0; y <= z.y1; y++) {
        const row = y * this.width;
        for (let x = z.x0; x <= z.x1; x++) this.mask[row + x] |= bit;
      }
    }
  }
}
