// Camera with discrete zoom levels (pixels per tile). Position is in tile units
// at the centre of the viewport so zooming feels stable around a focus point.

export const ZOOM_LEVELS = [4, 8, 16, 32];

export class Camera {
  /** Tile-space coordinate currently centred in the viewport. */
  x = 0;
  y = 0;
  zoomIndex = 1;

  get pxPerTile(): number {
    return ZOOM_LEVELS[this.zoomIndex];
  }

  setZoom(index: number): void {
    this.zoomIndex = clamp(index, 0, ZOOM_LEVELS.length - 1);
  }

  zoomBy(delta: number, focusTileX: number, focusTileY: number): void {
    const next = clamp(this.zoomIndex + delta, 0, ZOOM_LEVELS.length - 1);
    if (next === this.zoomIndex) return;
    // Recentre so the focus tile stays under the cursor.
    const dx = focusTileX - this.x;
    const dy = focusTileY - this.y;
    const ratio = ZOOM_LEVELS[this.zoomIndex] / ZOOM_LEVELS[next];
    this.x = focusTileX - dx * ratio;
    this.y = focusTileY - dy * ratio;
    this.zoomIndex = next;
  }

  /** Convert a screen pixel to a fractional tile coordinate. */
  screenToTile(px: number, py: number, viewW: number, viewH: number): { x: number; y: number } {
    const pt = this.pxPerTile;
    return {
      x: this.x + (px - viewW / 2) / pt,
      y: this.y + (py - viewH / 2) / pt,
    };
  }

  /** Convert a tile to its top-left screen pixel. */
  tileToScreen(tileX: number, tileY: number, viewW: number, viewH: number): { x: number; y: number } {
    const pt = this.pxPerTile;
    return {
      x: viewW / 2 + (tileX - this.x) * pt,
      y: viewH / 2 + (tileY - this.y) * pt,
    };
  }

  /** Bounds of visible tiles, inclusive lo, exclusive hi. */
  visibleBounds(viewW: number, viewH: number): { x0: number; y0: number; x1: number; y1: number } {
    const pt = this.pxPerTile;
    const halfTilesW = viewW / 2 / pt;
    const halfTilesH = viewH / 2 / pt;
    return {
      x0: Math.floor(this.x - halfTilesW) - 1,
      y0: Math.floor(this.y - halfTilesH) - 1,
      x1: Math.ceil(this.x + halfTilesW) + 1,
      y1: Math.ceil(this.y + halfTilesH) + 1,
    };
  }

  pan(dxTiles: number, dyTiles: number): void {
    this.x += dxTiles;
    this.y += dyTiles;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
