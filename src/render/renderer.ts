import { Camera } from "./camera";
import { SimWorld } from "../sim/world/simWorld";
import { TileType } from "../sim/world/tiles";
import { getDwarfSprite, getTileSprite, SPRITE_TILE_SIZE } from "./sprites";

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  sim: SimWorld,
  camera: Camera,
  viewW: number,
  viewH: number,
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

  // Blueprint cavities: faint outline + tint over each active blueprint so the
  // observer can see what the dwarves intend to dig. The player never created
  // these — the Colony Planner did. They aren't a UI primitive, just a visible
  // expression of the colony's intention.
  const planner = sim.planner;
  if (planner.blueprints.length > 0) {
    ctx.save();
    for (const b of planner.blueprints) {
      if (b.status !== "digging") continue;
      const ax = (b.originX - camera.x) * pt + viewW / 2;
      const ay = (b.originY - camera.y) * pt + viewH / 2;
      const bw = b.width * pt;
      const bh = b.height * pt;
      ctx.fillStyle = "rgba(220, 180, 90, 0.10)";
      ctx.fillRect(ax, ay, bw, bh);
      ctx.strokeStyle = "rgba(220, 180, 90, 0.55)";
      ctx.lineWidth = 1;
      // Dashed outline so it reads as a "plan" rather than "structure".
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(ax + 0.5, ay + 0.5, bw - 1, bh - 1);
      ctx.setLineDash([]);
    }
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
