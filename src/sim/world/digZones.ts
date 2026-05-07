// Player-painted Dig Zone rectangles. Stored as a small list of axis-aligned
// rectangles since at most a handful are active at once and the BFS scanner
// checks them per-step.

export interface DigZone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class DigZones {
  zones: DigZone[] = [];

  add(z: DigZone): void {
    const norm: DigZone = {
      x0: Math.min(z.x0, z.x1),
      y0: Math.min(z.y0, z.y1),
      x1: Math.max(z.x0, z.x1),
      y1: Math.max(z.y0, z.y1),
    };
    this.zones.push(norm);
  }

  /** Removes all zones overlapping the given rect. */
  remove(rect: DigZone): void {
    const r: DigZone = {
      x0: Math.min(rect.x0, rect.x1),
      y0: Math.min(rect.y0, rect.y1),
      x1: Math.max(rect.x0, rect.x1),
      y1: Math.max(rect.y0, rect.y1),
    };
    this.zones = this.zones.filter(
      (z) => !(z.x0 <= r.x1 && z.x1 >= r.x0 && z.y0 <= r.y1 && z.y1 >= r.y0),
    );
  }

  clear(): void {
    this.zones = [];
  }

  contains(x: number, y: number): boolean {
    for (const z of this.zones) {
      if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) return true;
    }
    return false;
  }

  isEmpty(): boolean {
    return this.zones.length === 0;
  }
}
