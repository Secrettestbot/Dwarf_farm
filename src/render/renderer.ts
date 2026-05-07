import { Camera } from "./camera";
import { SimWorld } from "../sim/world/simWorld";
import { TileType } from "../sim/world/tiles";
import { getDwarfSprite, getTileSprite, SPRITE_TILE_SIZE } from "./sprites";

export interface RenderOptions {
  digZonePreview?: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  sim: SimWorld,
  camera: Camera,
  viewW: number,
  viewH: number,
  options: RenderOptions = {},
): void {
  ctx.fillStyle = "#070708";
  ctx.fillRect(0, 0, viewW, viewH);

  const { x0, y0, x1, y1 } = camera.visibleBounds(viewW, viewH);
  const pt = camera.pxPerTile;
  const grid = sim.grid;

  // Draw tiles. We blit the tile sprite from a 16×16 source into pt×pt on
  // screen with imageSmoothing disabled so pixels stay crisp.
  for (let y = Math.max(0, y0); y < Math.min(grid.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(grid.width, x1); x++) {
      const t = grid.getTile(x, y);
      if (t === TileType.Air) continue;
      const sprite = getTileSprite(t as TileType);
      const sx = (x - camera.x) * pt + viewW / 2;
      const sy = (y - camera.y) * pt + viewH / 2;
      ctx.drawImage(sprite as CanvasImageSource, 0, 0, SPRITE_TILE_SIZE, SPRITE_TILE_SIZE, sx, sy, pt, pt);
    }
  }

  // Dig zone tinting.
  if (sim.digZones.zones.length > 0) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 220, 80, 0.18)";
    for (const z of sim.digZones.zones) {
      const ax = (z.x0 - camera.x) * pt + viewW / 2;
      const ay = (z.y0 - camera.y) * pt + viewH / 2;
      const bx = (z.x1 + 1 - camera.x) * pt + viewW / 2;
      const by = (z.y1 + 1 - camera.y) * pt + viewH / 2;
      ctx.fillRect(ax, ay, bx - ax, by - ay);
      ctx.strokeStyle = "rgba(255, 220, 80, 0.65)";
      ctx.lineWidth = 1;
      ctx.strokeRect(ax + 0.5, ay + 0.5, bx - ax - 1, by - ay - 1);
    }
    ctx.restore();
  }

  // Drag preview rectangle while painting.
  if (options.digZonePreview) {
    const z = options.digZonePreview;
    const ax = (Math.min(z.x0, z.x1) - camera.x) * pt + viewW / 2;
    const ay = (Math.min(z.y0, z.y1) - camera.y) * pt + viewH / 2;
    const bx = (Math.max(z.x0, z.x1) + 1 - camera.x) * pt + viewW / 2;
    const by = (Math.max(z.y0, z.y1) + 1 - camera.y) * pt + viewH / 2;
    ctx.save();
    ctx.fillStyle = "rgba(255, 240, 120, 0.25)";
    ctx.fillRect(ax, ay, bx - ax, by - ay);
    ctx.strokeStyle = "#ffe066";
    ctx.lineWidth = 2;
    ctx.strokeRect(ax + 0.5, ay + 0.5, bx - ax - 1, by - ay - 1);
    ctx.restore();
  }

  // Draw dwarves on top.
  const dwarfSprite = getDwarfSprite();
  sim.forEachDwarf((_id, pos) => {
    const sx = (pos.x - camera.x) * pt + viewW / 2;
    const sy = (pos.y - camera.y) * pt + viewH / 2;
    ctx.drawImage(dwarfSprite as CanvasImageSource, 0, 0, SPRITE_TILE_SIZE, SPRITE_TILE_SIZE, sx, sy, pt, pt);
  });
}
