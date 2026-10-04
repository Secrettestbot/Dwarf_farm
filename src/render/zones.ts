import { SimWorld } from "../sim/world/simWorld";
import { ZoneKind } from "../sim/zones";
import { Camera } from "./camera";

const ZONE_STYLE: Record<ZoneKind, { fill: string; stroke: string }> = {
  dig: { fill: "rgba(224,192,128,0.14)", stroke: "rgba(224,192,128,0.8)" },
  forbidden: { fill: "rgba(224,112,80,0.18)", stroke: "rgba(224,112,80,0.9)" },
  gather: { fill: "rgba(154,211,163,0.14)", stroke: "rgba(154,211,163,0.8)" },
};

function drawRect(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  viewW: number,
  viewH: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  style: { fill: string; stroke: string },
  dashed: boolean,
): void {
  const a = camera.tileToScreen(x0, y0, viewW, viewH);
  const b = camera.tileToScreen(x1 + 1, y1 + 1, viewW, viewH);
  if (b.x < 0 || b.y < 0 || a.x > viewW || a.y > viewH) return;
  ctx.fillStyle = style.fill;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1;
  ctx.setLineDash(dashed ? [4, 3] : []);
  ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
  ctx.setLineDash([]);
}

/** Overlay the player's zones, plus an in-progress drag preview. */
export function renderZones(
  ctx: CanvasRenderingContext2D,
  sim: SimWorld,
  camera: Camera,
  viewW: number,
  viewH: number,
  preview: { kind: ZoneKind; x0: number; y0: number; x1: number; y1: number } | null,
): void {
  for (const z of sim.zones.zones) {
    drawRect(ctx, camera, viewW, viewH, z.x0, z.y0, z.x1, z.y1, ZONE_STYLE[z.kind], false);
  }
  if (preview) {
    drawRect(
      ctx, camera, viewW, viewH,
      Math.min(preview.x0, preview.x1), Math.min(preview.y0, preview.y1),
      Math.max(preview.x0, preview.x1), Math.max(preview.y0, preview.y1),
      ZONE_STYLE[preview.kind], true,
    );
  }
}
