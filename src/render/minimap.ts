import { SimWorld } from "../sim/world/simWorld";
import { Camera } from "./camera";
import { TileType, tileColor } from "../sim/world/tiles";
import { LAYER_TINTS, layerOf } from "./sprites";

// Persistent thumbnail of the explored world. Rendered into an offscreen
// canvas once per second; the visible viewport is overlaid each frame.
// The 400×2000 world is mostly unexplored for most of a run, so the
// thumbnail frames only the seen region (plus a margin) instead of
// squashing the colony into a sliver at the top.

const REFRESH_MS = 1000;
/** Tiles of unexplored margin kept around the seen region. */
const VIEW_MARGIN = 12;
/** Smallest region the minimap will zoom into, in tiles. */
const MIN_VIEW = 48;

export class Minimap {
  width: number = 0;
  height: number = 0;
  private buffer!: HTMLCanvasElement;
  private bctx!: CanvasRenderingContext2D;
  private lastRefresh = -Infinity;
  /** World-tile rectangle the thumbnail currently shows. */
  private view = { x: 0, y: 0, w: 1, h: 1 };
  /** Where the minimap was last drawn on screen (CSS px). */
  private drawnAt: { x: number; y: number } | null = null;

  constructor(worldW: number, worldH: number, width: number, height: number) {
    this.view = { x: 0, y: 0, w: worldW, h: worldH };
    this.rebuildCanvas(width, height);
  }

  /** Resize the minimap to an arbitrary pixel width × height. The
   * minimap samples the world independently along each axis, so
   * stretching / squishing here doesn't preserve the world's
   * aspect — that's the trade-off the player explicitly chose
   * when they grabbed the slider. The next refresh() call repaints
   * into the new canvas (lastRefresh reset forces it). */
  setDimensions(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.rebuildCanvas(width, height);
    this.lastRefresh = -Infinity;
  }

  private rebuildCanvas(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    this.buffer = canvas;
    this.bctx = canvas.getContext("2d", { willReadFrequently: true })!;
  }

  refresh(sim: SimWorld, nowMs: number, force = false): void {
    if (!force && nowMs - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = nowMs;
    this.view = seenBounds(sim);
    const v = this.view;
    const img = this.bctx.createImageData(this.width, this.height);
    const data = img.data;
    const surfaceRefY = sim.spawn.y - 3;
    for (let py = 0; py < this.height; py++) {
      const wy = v.y + Math.floor((py / this.height) * v.h);
      const tint = LAYER_TINTS[layerOf(wy, surfaceRefY)] ?? LAYER_TINTS[0];
      for (let px = 0; px < this.width; px++) {
        const wx = v.x + Math.floor((px / this.width) * v.w);
        const off = (py * this.width + px) * 4;
        // Unseen tiles paint as flat near-black so the minimap doesn't
        // give away the unmined layout.
        if (!sim.grid.isSeen(wx, wy)) {
          data[off] = 5;
          data[off + 1] = 5;
          data[off + 2] = 7;
          data[off + 3] = 255;
          continue;
        }
        const t = sim.grid.getTile(wx, wy);
        const col = t === TileType.Air ? 0x000000 : tileColor(t);
        const r = ((col >> 16) & 0xff) * tint[0];
        const g = ((col >> 8) & 0xff) * tint[1];
        const b = (col & 0xff) * tint[2];
        data[off] = Math.max(0, Math.min(255, Math.round(r)));
        data[off + 1] = Math.max(0, Math.min(255, Math.round(g)));
        data[off + 2] = Math.max(0, Math.min(255, Math.round(b)));
        data[off + 3] = 255;
      }
    }
    // Mark dwarves.
    sim.forEachDwarf((_id, pos) => {
      const px = Math.floor(((pos.x - v.x) / v.w) * this.width);
      const py = Math.floor(((pos.y - v.y) / v.h) * this.height);
      if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
      const off = (py * this.width + px) * 4;
      data[off] = 255;
      data[off + 1] = 255;
      data[off + 2] = 255;
      data[off + 3] = 255;
    });
    this.bctx.putImageData(img, 0, 0);
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, camera: Camera, viewW: number, viewH: number): void {
    // Frame.
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x - 4, y - 4, this.width + 8, this.height + 8);
    ctx.strokeStyle = "#666";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, this.width + 1, this.height + 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.buffer, x, y);
    this.drawnAt = { x, y };
    const v = this.view;

    // Viewport rectangle overlay.
    const pt = camera.pxPerTile;
    const vw = viewW / pt;
    const vh = viewH / pt;
    const vx = camera.x - vw / 2;
    const vy = camera.y - vh / 2;
    const sx = x + ((vx - v.x) / v.w) * this.width;
    const sy = y + ((vy - v.y) / v.h) * this.height;
    const sw = (vw / v.w) * this.width;
    const sh = (vh / v.h) * this.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, this.width, this.height);
    ctx.clip();
    ctx.strokeStyle = "#ffe066";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.restore();
  }

  /** World tile under a screen point, or null when the point is
   * outside the minimap (or it hasn't been drawn yet). */
  tileAtScreen(screenX: number, screenY: number): { x: number; y: number } | null {
    if (!this.drawnAt) return null;
    const lx = screenX - this.drawnAt.x;
    const ly = screenY - this.drawnAt.y;
    if (lx < 0 || ly < 0 || lx >= this.width || ly >= this.height) return null;
    return this.pickTile(lx, ly);
  }

  /** Forget the last draw position (e.g. while the minimap is hidden). */
  clearDrawn(): void {
    this.drawnAt = null;
  }

  /** Click at minimap-local pixel returns the world tile under it. */
  pickTile(localX: number, localY: number): { x: number; y: number } {
    const v = this.view;
    return {
      x: Math.floor(v.x + (localX / this.width) * v.w),
      y: Math.floor(v.y + (localY / this.height) * v.h),
    };
  }
}

/** Bounding box of every seen tile, padded and clamped to the world. */
export function seenBounds(sim: SimWorld): { x: number; y: number; w: number; h: number } {
  const g = sim.grid;
  if (g.seenMaxX < 0) return { x: 0, y: 0, w: g.width, h: g.height };
  const x0 = g.seenMinX;
  const x1 = g.seenMaxX;
  let y0 = g.seenMinY;
  const y1 = g.seenMaxY;
  // Always include the sky above the entrance so the surface reads.
  y0 = Math.min(y0, Math.max(0, sim.spawn.y - 20));
  const pad = (lo: number, hi: number, size: number) => {
    lo -= VIEW_MARGIN;
    hi += VIEW_MARGIN;
    const span = hi - lo + 1;
    if (span < MIN_VIEW) {
      const grow = MIN_VIEW - span;
      lo -= Math.floor(grow / 2);
      hi += Math.ceil(grow / 2);
    }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > size - 1) { lo -= hi - (size - 1); hi = size - 1; }
    lo = Math.max(0, lo);
    return { lo, span: hi - lo + 1 };
  };
  const px = pad(x0, x1, g.width);
  const py = pad(y0, y1, g.height);
  return { x: px.lo, y: py.lo, w: px.span, h: py.span };
}
