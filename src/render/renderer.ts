import { Camera } from "./camera";
import { SimWorld } from "../sim/world/simWorld";
import { TileType } from "../sim/world/tiles";
import { getDwarfSprite, getHostileSprite, getTileSpriteAtLayer, layerOf, SPRITE_TILE_SIZE } from "./sprites";
import { BlueprintKind } from "../sim/planner/blueprint";

const BLUEPRINT_COLORS: Record<BlueprintKind, { fill: string; stroke: string }> = {
  bedroom: { fill: "rgba(220, 180, 90, 0.10)", stroke: "rgba(220, 180, 90, 0.55)" },
  dining_hall: { fill: "rgba(140, 200, 230, 0.12)", stroke: "rgba(140, 200, 230, 0.6)" },
  stockpile: { fill: "rgba(180, 230, 130, 0.10)", stroke: "rgba(180, 230, 130, 0.55)" },
  corridor: { fill: "rgba(180, 180, 180, 0.10)", stroke: "rgba(180, 180, 180, 0.50)" },
  mine: { fill: "rgba(220, 130, 60, 0.14)", stroke: "rgba(240, 150, 70, 0.7)" },
  farm: { fill: "rgba(140, 200, 90, 0.12)", stroke: "rgba(160, 220, 110, 0.65)" },
  stairwell: { fill: "rgba(230, 130, 200, 0.10)", stroke: "rgba(230, 130, 200, 0.55)" },
  kitchen: { fill: "rgba(220, 110, 80, 0.12)", stroke: "rgba(230, 130, 90, 0.65)" },
  brewery: { fill: "rgba(120, 180, 90, 0.12)", stroke: "rgba(140, 200, 110, 0.65)" },
  smelter: { fill: "rgba(190, 90, 60, 0.14)", stroke: "rgba(220, 110, 70, 0.7)" },
  forge: { fill: "rgba(220, 140, 80, 0.14)", stroke: "rgba(240, 160, 100, 0.7)" },
  trade_depot: { fill: "rgba(180, 200, 220, 0.10)", stroke: "rgba(200, 220, 240, 0.65)" },
  library: { fill: "rgba(120, 160, 220, 0.10)", stroke: "rgba(150, 180, 240, 0.65)" },
  armoury: { fill: "rgba(180, 180, 220, 0.10)", stroke: "rgba(200, 200, 240, 0.65)" },
};

const ACTIVITY_GLYPH: Record<string, { glyph: string; color: string }> = {
  mine: { glyph: "⛏", color: "#e0c080" },
  sleep: { glyph: "z", color: "#8aa9ff" },
  socialise: { glyph: "♥", color: "#ff9aa2" },
  wander: { glyph: ".", color: "#999" },
  haul: { glyph: "↕", color: "#9ad3a3" },
  craft: { glyph: "✦", color: "#e0a070" },
  tend: { glyph: "✿", color: "#7aa040" },
  maintain: { glyph: "•", color: "#aaa" },
  shelter: { glyph: "!", color: "#e07050" },
  engage: { glyph: "⚔", color: "#e0c080" },
  research: { glyph: "📖", color: "#8aa9ff" },
};

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

  // Tiles. Each row picks a layer index from its depth so the palette
  // shifts cooler as the colony descends — Skin warm browns, Shallow
  // Earth cool grey, Deep Rock blue-grey, etc. (GDD §11.3). Sprites are
  // pre-tinted per layer and cached, so render-time cost is just a
  // lookup.
  const surfaceRefY = sim.spawn.y - 3; // spawn cavern sits a few tiles below true surface
  for (let y = Math.max(0, y0); y < Math.min(grid.height, y1); y++) {
    const layer = layerOf(y, surfaceRefY);
    for (let x = Math.max(0, x0); x < Math.min(grid.width, x1); x++) {
      const sx = (x - camera.x) * pt + viewW / 2;
      const sy = (y - camera.y) * pt + viewH / 2;
      // Fog of war: the dwarves haven't seen this tile yet — draw a flat
      // black square so the unmined mountain is opaque, in keeping with
      // the GDD's "the player never knows exactly what lies ahead until
      // the stone is broken" rule.
      if (!grid.isSeen(x, y)) {
        ctx.fillStyle = "#050507";
        ctx.fillRect(sx, sy, pt, pt);
        continue;
      }
      const t = grid.getTile(x, y);
      if (t === TileType.Air) continue;
      const sprite = getTileSpriteAtLayer(t as TileType, layer);
      ctx.drawImage(sprite as CanvasImageSource, 0, 0, SPRITE_TILE_SIZE, SPRITE_TILE_SIZE, sx, sy, pt, pt);
    }
  }

  // Blueprints (active only). Color-coded by kind so the colony's intent is
  // legible at a glance: a yellow rectangle is a bedroom, blue is a dining
  // hall, green is a stockpile.
  const planner = sim.planner;
  if (planner.blueprints.length > 0) {
    ctx.save();
    for (const b of planner.blueprints) {
      if (b.status !== "digging") continue;
      const colors = BLUEPRINT_COLORS[b.kind];
      const ax = (b.originX - camera.x) * pt + viewW / 2;
      const ay = (b.originY - camera.y) * pt + viewH / 2;
      const bw = b.width * pt;
      const bh = b.height * pt;
      ctx.fillStyle = colors.fill;
      ctx.fillRect(ax, ay, bw, bh);
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(ax + 0.5, ay + 0.5, bw - 1, bh - 1);
      ctx.setLineDash([]);
      // Kind label, top-left of cavity, only when zoomed in enough.
      if (pt >= 8) {
        ctx.fillStyle = colors.stroke;
        ctx.font = "10px monospace";
        ctx.fillText(formatKindLabel(b.kind), ax + 3, ay + 11);
      }
    }
    ctx.restore();
  }

  // Loose items on the floor — output of mining, input to haul jobs.
  // Drawn as small palette-coloured chips so a hauler can spot a pile.
  const itemEnts = sim.item.entities;
  for (let i = 0; i < itemEnts.length; i++) {
    const ie = itemEnts[i];
    const p = sim.position.get(ie);
    const it = sim.item.get(ie);
    if (!p || !it) continue;
    if (!grid.isSeen(p.x, p.y)) continue;
    const sx = (p.x - camera.x) * pt + viewW / 2;
    const sy = (p.y - camera.y) * pt + viewH / 2;
    ctx.fillStyle =
      it.kind === "ore" ? "#e0c070" :
      it.kind === "stone" ? "#9a9aa3" :
      it.kind === "gem" ? "#a8d8e0" :
      it.kind === "bars" ? "#d0a060" :
      it.kind === "tools" ? "#c0c8d0" :
      "#8a6a4a";
    const m = pt * 0.25;
    ctx.fillRect(sx + m, sy + pt - m * 1.5, pt - m * 2, m);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + m + 0.5, sy + pt - m * 1.5 + 0.5, pt - m * 2 - 1, m - 1);
  }

  // Hostiles below dwarves so dwarves draw over them in melee.
  const hostileEnts = sim.hostile.entities;
  for (let i = 0; i < hostileEnts.length; i++) {
    const e = hostileEnts[i];
    const p = sim.position.get(e);
    const h = sim.hostile.get(e);
    if (!p || !h) continue;
    const sprite = getHostileSprite(h.kind);
    const sx = (p.x - camera.x) * pt + viewW / 2;
    const sy = (p.y - camera.y) * pt + viewH / 2;
    ctx.drawImage(sprite as CanvasImageSource, 0, 0, SPRITE_TILE_SIZE, SPRITE_TILE_SIZE, sx, sy, pt, pt);
  }

  // Dwarves on top.
  const dwarfSprite = getDwarfSprite();
  ctx.font = `${Math.max(8, Math.floor(pt * 0.6))}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  sim.forEachDwarf((id, pos) => {
    const sx = (pos.x - camera.x) * pt + viewW / 2;
    const sy = (pos.y - camera.y) * pt + viewH / 2;
    ctx.drawImage(dwarfSprite as CanvasImageSource, 0, 0, SPRITE_TILE_SIZE, SPRITE_TILE_SIZE, sx, sy, pt, pt);
    // Activity glyph above the dwarf.
    if (pt >= 8) {
      const job = sim.job.get(id);
      if (job) {
        const g = ACTIVITY_GLYPH[job.kind];
        if (g) {
          ctx.fillStyle = g.color;
          ctx.fillText(g.glyph, sx + pt / 2, sy - 2);
        }
      }
    }
  });
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function formatKindLabel(kind: BlueprintKind): string {
  switch (kind) {
    case "bedroom": return "bed";
    case "dining_hall": return "dining";
    case "stockpile": return "stockpile";
    case "corridor": return "tunnel";
    case "mine": return "mine";
    case "farm": return "farm";
    case "stairwell": return "stair";
    case "kitchen": return "kitchen";
    case "brewery": return "brewery";
    case "smelter": return "smelter";
    case "forge": return "forge";
    case "trade_depot": return "depot";
    case "library": return "library";
    case "armoury": return "armoury";
  }
}
