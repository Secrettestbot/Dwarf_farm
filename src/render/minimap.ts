import { SimWorld } from "../sim/world/simWorld";
import { Camera } from "./camera";
import { TileType, tileColor } from "../sim/world/tiles";
import { LAYER_TINTS, layerOf } from "./sprites";

// Persistent thumbnail of the full world. Rendered into an offscreen canvas
// once per second; the visible viewport is overlaid each frame.

const REFRESH_MS = 1000;
const TARGET_W = 200;
const TARGET_H = 80;

export class Minimap {
  readonly width: number;
  readonly height: number;
  private buffer: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private lastRefresh = -Infinity;
  private worldW: number;
  private worldH: number;

  constructor(worldW: number, worldH: number) {
    this.worldW = worldW;
    this.worldH = worldH;
    // Pick dimensions that preserve the world aspect roughly within the panel.
    const aspect = worldW / worldH;
    if (aspect > TARGET_W / TARGET_H) {
      this.width = TARGET_W;
      this.height = Math.max(20, Math.round(TARGET_W / aspect));
    } else {
      this.height = TARGET_H;
      this.width = Math.max(40, Math.round(TARGET_H * aspect));
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    this.buffer = canvas;
    this.bctx = canvas.getContext("2d", { willReadFrequently: true })!;
  }

  refresh(sim: SimWorld, nowMs: number, force = false): void {
    if (!force && nowMs - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = nowMs;
    const img = this.bctx.createImageData(this.width, this.height);
    const data = img.data;
    const surfaceRefY = sim.spawn.y - 3;
    for (let py = 0; py < this.height; py++) {
      const wy = Math.floor((py / this.height) * sim.grid.height);
      const tint = LAYER_TINTS[layerOf(wy, surfaceRefY)] ?? LAYER_TINTS[0];
      for (let px = 0; px < this.width; px++) {
        const wx = Math.floor((px / this.width) * sim.grid.width);
        const t = sim.grid.getTile(wx, wy);
        const col = t === TileType.Air ? 0x000000 : tileColor(t);
        const off = (py * this.width + px) * 4;
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
      const px = Math.floor((pos.x / sim.grid.width) * this.width);
      const py = Math.floor((pos.y / sim.grid.height) * this.height);
      const off = (py * this.width + px) * 4;
      if (off >= 0 && off < data.length - 4) {
        data[off] = 255;
        data[off + 1] = 255;
        data[off + 2] = 255;
        data[off + 3] = 255;
      }
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

    // Viewport rectangle overlay.
    const pt = camera.pxPerTile;
    const vw = viewW / pt;
    const vh = viewH / pt;
    const vx = camera.x - vw / 2;
    const vy = camera.y - vh / 2;
    const sx = x + (vx / this.worldW) * this.width;
    const sy = y + (vy / this.worldH) * this.height;
    const sw = (vw / this.worldW) * this.width;
    const sh = (vh / this.worldH) * this.height;
    ctx.strokeStyle = "#ffe066";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, sy, sw, sh);
  }

  /** Click at minimap-local pixel returns the world tile under it. */
  pickTile(localX: number, localY: number): { x: number; y: number } {
    return {
      x: Math.floor((localX / this.width) * this.worldW),
      y: Math.floor((localY / this.height) * this.worldH),
    };
  }
}
