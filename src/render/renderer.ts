import { Camera } from "./camera";
import { SimWorld } from "../sim/world/simWorld";
import { TileType } from "../sim/world/tiles";
import { getDwarfSprite, getHostileSprite, getPetSprite, getTileSpriteAtLayer, layerOf, SPRITE_TILE_SIZE } from "./sprites";
import { BlueprintKind } from "../sim/planner/blueprint";
import { seasonOf } from "../sim/time";

/** Per-season RGBA overlay applied to surface tiles (Grass, Tree).
 * Spring is baseline (no overlay); summer adds a warm gold cast;
 * autumn paints orange-red; winter washes everything white-grey. */
const SEASON_TINTS: Record<"spring" | "summer" | "autumn" | "winter", string | null> = {
  spring: null,
  summer: "rgba(240, 200, 80, 0.18)",
  autumn: "rgba(220, 110, 40, 0.25)",
  winter: "rgba(220, 230, 255, 0.45)",
};

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
  throne_room: { fill: "rgba(160, 100, 200, 0.12)", stroke: "rgba(180, 120, 230, 0.7)" },
  pump_station: { fill: "rgba(60, 130, 170, 0.12)", stroke: "rgba(90, 160, 200, 0.65)" },
  mason: { fill: "rgba(140, 140, 160, 0.12)", stroke: "rgba(170, 170, 190, 0.65)" },
  jeweller: { fill: "rgba(180, 130, 220, 0.12)", stroke: "rgba(200, 160, 240, 0.7)" },
  carpenter: { fill: "rgba(180, 130, 70, 0.12)", stroke: "rgba(200, 150, 90, 0.7)" },
  lumberyard: { fill: "rgba(90, 160, 70, 0.18)", stroke: "rgba(120, 200, 100, 0.75)" },
  kiln: { fill: "rgba(200, 110, 70, 0.14)", stroke: "rgba(220, 130, 80, 0.7)" },
  tannery: { fill: "rgba(140, 100, 60, 0.14)", stroke: "rgba(170, 130, 80, 0.7)" },
  loom: { fill: "rgba(200, 190, 170, 0.14)", stroke: "rgba(220, 210, 190, 0.7)" },
  hospital: { fill: "rgba(220, 200, 200, 0.12)", stroke: "rgba(240, 220, 220, 0.7)" },
  tavern: { fill: "rgba(200, 160, 100, 0.14)", stroke: "rgba(220, 180, 110, 0.7)" },
  magma_forge: { fill: "rgba(220, 80, 40, 0.18)", stroke: "rgba(240, 110, 60, 0.8)" },
  water_wheel: { fill: "rgba(80, 110, 160, 0.16)", stroke: "rgba(100, 140, 200, 0.75)" },
  cemetery: { fill: "rgba(120, 110, 100, 0.16)", stroke: "rgba(160, 150, 140, 0.7)" },
};

/** Per-kind floor tint painted over a completed room's cavity tiles.
 * Same hue family as the digging-stage BLUEPRINT_COLORS fill but with
 * a slightly higher alpha so the room reads clearly when stable. The
 * tint is subtle (~12% alpha) so it doesn't fight the central
 * furniture / station sprite — just enough that a glance picks the
 * room apart from neighbouring corridor floor. */
const ROOM_FLOOR_TINT: Partial<Record<BlueprintKind, string>> = {
  bedroom: "rgba(220, 180, 90, 0.12)",
  dining_hall: "rgba(140, 200, 230, 0.14)",
  stockpile: "rgba(180, 230, 130, 0.12)",
  farm: "rgba(140, 200, 90, 0.14)",
  kitchen: "rgba(220, 110, 80, 0.14)",
  brewery: "rgba(120, 180, 90, 0.14)",
  smelter: "rgba(190, 90, 60, 0.16)",
  forge: "rgba(220, 140, 80, 0.16)",
  trade_depot: "rgba(180, 200, 220, 0.12)",
  library: "rgba(120, 160, 220, 0.12)",
  armoury: "rgba(180, 180, 220, 0.12)",
  throne_room: "rgba(160, 100, 200, 0.14)",
  pump_station: "rgba(60, 130, 170, 0.14)",
  mason: "rgba(140, 140, 160, 0.14)",
  jeweller: "rgba(180, 130, 220, 0.14)",
  carpenter: "rgba(180, 130, 70, 0.14)",
  kiln: "rgba(200, 110, 70, 0.16)",
  tannery: "rgba(140, 100, 60, 0.16)",
  loom: "rgba(200, 190, 170, 0.14)",
  hospital: "rgba(220, 200, 200, 0.14)",
  tavern: "rgba(200, 160, 100, 0.16)",
  magma_forge: "rgba(220, 80, 40, 0.18)",
  water_wheel: "rgba(80, 110, 160, 0.18)",
  cemetery: "rgba(120, 110, 100, 0.16)",
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
  pump: { glyph: "≈", color: "#80b0d0" },
  visit_grave: { glyph: "†", color: "#9a8a72" },
  treat: { glyph: "+", color: "#ffd0d0" },
  trade: { glyph: "$", color: "#e0c080" },
};

/** Disease pip colour by kind — the pip is rendered below the dwarf
 * sprite so an outbreak is legible at a glance even when the camera
 * is zoomed out. Fades from light cough-yellow to deep wound-red. */
const DISEASE_PIP: Record<string, string> = {
  cave_cough: "#d8c060",
  deep_fever: "#e08840",
  wound_sickness: "#e04040",
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
      // Seasonal overlay on surface tiles (Grass + Tree). Other
      // tiles stay constant — the deep mountain doesn't have
      // seasons. Overlay alpha is small for spring/summer, large for
      // winter so snow reads at a glance.
      if (t === TileType.Grass || t === TileType.Tree) {
        const tint = SEASON_TINTS[seasonOf(sim.tick)];
        if (tint) {
          ctx.fillStyle = tint;
          ctx.fillRect(sx, sy, pt, pt);
        }
      }
    }
  }

  // Blueprints. Active (digging) blueprints get a dashed outline + label so
  // the colony's intent is legible. Needs-furnishing and complete rooms
  // get a soft floor tint so each finished room reads as its kind even
  // when its central furniture tile is faint or off-screen. Without the
  // tint, half a dozen workshops look like indistinguishable corridor
  // grids — the room-character lives in the tint, not the centre tile.
  const planner = sim.planner;
  if (planner.blueprints.length > 0) {
    ctx.save();
    for (const b of planner.blueprints) {
      if (b.status === "digging") {
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
      } else {
        // needs_furnishing and complete: soft per-cell tint so the
        // room's identity carries across its whole floor. Corridors
        // and other passages skip the tint — they're not rooms.
        if (b.kind === "corridor" || b.kind === "mine" || b.kind === "stairwell" || b.kind === "lumberyard") continue;
        const tint = ROOM_FLOOR_TINT[b.kind];
        if (!tint) continue;
        ctx.fillStyle = tint;
        for (let i = 0; i < b.cavity.length; i++) {
          const c = b.cavity[i];
          const x = c & 0xffff;
          const y = (c >>> 16) & 0xffff;
          if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
          if (!grid.isSeen(x, y)) continue;
          const sx = (x - camera.x) * pt + viewW / 2;
          const sy = (y - camera.y) * pt + viewH / 2;
          ctx.fillRect(sx, sy, pt, pt);
        }
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
    ctx.fillStyle = itemKindColor(it.kind);
    const m = pt * 0.25;
    ctx.fillRect(sx + m, sy + pt - m * 1.5, pt - m * 2, m);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + m + 0.5, sy + pt - m * 1.5 + 0.5, pt - m * 2 - 1, m - 1);
    // Quality glint: items above baseline get a small bright pip on
    // the corner so masterworks read at a glance. Tier 0 (basic) →
    // nothing; Fine/Superior/Exceptional/Masterwork get progressively
    // brighter golden pips. GDD §6.3 quality tiers.
    const q = it.quality ?? 0;
    if (q > 0 && pt >= 8) {
      const pipColors = ["", "#d8b870", "#e6c878", "#f0d880", "#ffe890"];
      ctx.fillStyle = pipColors[Math.min(4, q)];
      const ps = Math.max(2, Math.floor(pt * 0.18));
      ctx.fillRect(sx + pt - ps - 1, sy + 1, ps, ps);
    }
  }

  // Caravan trader pip. Drawn before hostiles + dwarves so anyone
  // standing on the depot tile renders over the trader. Caravan
  // presence is indicated by sim.caravanLeavesTick > 0; the pip is a
  // small wagon-coloured square plus a label so the player can pick
  // out a visiting kingdom at a glance.
  if (sim.caravanLeavesTick > 0 && grid.isSeen(sim.caravanX, sim.caravanY)) {
    const cx = (sim.caravanX - camera.x) * pt + viewW / 2;
    const cy = (sim.caravanY - camera.y) * pt + viewH / 2;
    ctx.fillStyle = "#c89060";
    const m = Math.max(2, Math.floor(pt * 0.25));
    ctx.fillRect(cx + m, cy + m, pt - m * 2, pt - m * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(cx + m + 0.5, cy + m + 0.5, pt - m * 2 - 1, pt - m * 2 - 1);
    if (pt >= 10) {
      ctx.fillStyle = "#e8c0a0";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText("caravan", cx + pt / 2, cy - 2);
      ctx.textAlign = "start";
    }
  }

  // Throne room artifact display: when artifacts exist and a throne
  // room is built, paint the most recent artifact's name above the
  // throne tile so the colony's history is visible at a glance.
  if (sim.artifacts.length > 0 && pt >= 8) {
    let throneX = -1;
    let throneY = -1;
    outer: for (const b of sim.planner.blueprints) {
      if (b.kind !== "throne_room" || b.status !== "complete") continue;
      for (let i = 0; i < b.cavity.length; i++) {
        const c = b.cavity[i];
        const x = c & 0xffff;
        const y = (c >>> 16) & 0xffff;
        if (grid.getTile(x, y) === TileType.Throne) {
          throneX = x;
          throneY = y;
          break outer;
        }
      }
    }
    if (throneX >= 0 && grid.isSeen(throneX, throneY)) {
      const tx = (throneX - camera.x) * pt + viewW / 2;
      const ty = (throneY - camera.y) * pt + viewH / 2;
      const recent = sim.artifacts[sim.artifacts.length - 1];
      ctx.fillStyle = "#e0c080";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(recent.name, tx + pt / 2, ty - 4);
      ctx.textAlign = "start";
    }
  }

  // Pets — drawn between hostiles and dwarves so a tamed dog
  // standing next to its owner renders behind the dwarf. Wild pets
  // get a small "?" tag, tame pets a coloured collar pip.
  const petEnts = sim.pet.entities;
  for (let i = 0; i < petEnts.length; i++) {
    const id = petEnts[i];
    const p = sim.position.get(id);
    const pet = sim.pet.get(id);
    if (!p || !pet) continue;
    if (!grid.isSeen(p.x, p.y)) continue;
    const sprite = getPetSprite(pet.kind);
    const sx = (p.x - camera.x) * pt + viewW / 2;
    const sy = (p.y - camera.y) * pt + viewH / 2;
    ctx.drawImage(sprite as CanvasImageSource, 0, 0, SPRITE_TILE_SIZE, SPRITE_TILE_SIZE, sx, sy, pt, pt);
    if (pt >= 8) {
      if (pet.tamedAtTick < 0) {
        // Wild pet — white "wild" tag above.
        ctx.fillStyle = "#cccccc";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.fillText("wild", sx + pt / 2, sy - 2);
        ctx.textAlign = "start";
      } else {
        // Tame pet — small green collar pip in the corner.
        ctx.fillStyle = "#a8e090";
        const ps = Math.max(2, Math.floor(pt * 0.18));
        ctx.fillRect(sx + pt - ps - 1, sy + 1, ps, ps);
      }
    }
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
    // Wheelbarrow overlay — draws a small tub-on-wheel just behind
    // the dwarf when this haul checked one out of the colony pool.
    // The tub is tinted with the cargo's colour so a barrow loaded
    // with food reads differently from one full of stone at a
    // glance. Only renders at zooms where the detail's visible
    // (pt ≥ 6 keeps tiny zoom levels uncluttered).
    if (pt >= 6) {
      const carrying = sim.carrying.get(id);
      if (carrying?.withWheelbarrow) {
        drawWheelbarrow(ctx, sx, sy, pt, itemKindColor(carrying.kind));
      }
    }
    // Disease pip — small coloured dot at the dwarf's feet so an
    // outbreak is visible without opening the inspector. Drawn below
    // the activity glyph so both can coexist on a sick worker.
    if (pt >= 4) {
      const disease = sim.disease.get(id);
      if (disease) {
        const colour = DISEASE_PIP[disease.kind] ?? "#e04040";
        const r = Math.max(1, Math.floor(pt / 6));
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(sx + pt / 2, sy + pt - r, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
    case "throne_room": return "throne";
    case "pump_station": return "pump";
    case "mason": return "mason";
    case "jeweller": return "jeweller";
    case "carpenter": return "carpenter";
    case "lumberyard": return "tree";
    case "kiln": return "kiln";
    case "tannery": return "tannery";
    case "loom": return "loom";
    case "hospital": return "hospital";
    case "tavern": return "tavern";
    case "magma_forge": return "magma forge";
    case "water_wheel": return "wheel";
    case "cemetery": return "cemetery";
  }
}

/** Map an item kind to the colour used to render it on the floor
 * (and as the cargo tint of a wheelbarrow being pushed by a hauler).
 * Kept simple — one colour per kind, no quality variation. */
function itemKindColor(kind: string): string {
  switch (kind) {
    case "ore": return "#e0c070";
    case "stone": return "#9a9aa3";
    case "gem": return "#a8d8e0";
    case "bars": return "#d0a060";
    case "tools": return "#c0c8d0";
    case "food": return "#9ad3a3";
    case "drink": return "#8aa9ff";
    case "meal": return "#e0c080";
    case "wood": return "#a87838";
    case "hide": return "#8a5a3a";
    case "wheelbarrow": return "#a86838";
    default: return "#8a6a4a";
  }
}

/** Draw a small wheelbarrow behind / beside the dwarf at (sx, sy)
 * in screen pixels. `pt` is the per-tile pixel size; the
 * wheelbarrow's pieces all scale off it so the visual stays
 * legible at any zoom. `cargoColour` tints the tub interior — the
 * outline and wheel are fixed dark tones so the silhouette stays
 * readable. */
function drawWheelbarrow(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  pt: number,
  cargoColour: string,
): void {
  // Position the tub in the lower-right quadrant of the dwarf's
  // tile so it reads as "being pushed from in front." Slight
  // overhang past the tile's right edge keeps the silhouette from
  // crowding the dwarf body.
  const tubX = sx + pt * 0.45;
  const tubY = sy + pt * 0.55;
  const tubW = pt * 0.5;
  const tubH = pt * 0.25;
  // Tub body (cargo colour).
  ctx.fillStyle = cargoColour;
  ctx.fillRect(tubX, tubY, tubW, tubH);
  // Tub rim/outline — dark for silhouette readability.
  ctx.fillStyle = "#1a1410";
  ctx.fillRect(tubX, tubY, tubW, 1);
  ctx.fillRect(tubX, tubY + tubH - 1, tubW, 1);
  ctx.fillRect(tubX, tubY, 1, tubH);
  ctx.fillRect(tubX + tubW - 1, tubY, 1, tubH);
  // Wheel — small dark disc below the front of the tub.
  const wheelR = Math.max(1, pt * 0.1);
  const wheelX = tubX + tubW - wheelR;
  const wheelY = tubY + tubH + wheelR - 1;
  ctx.fillStyle = "#2a2620";
  ctx.beginPath();
  ctx.arc(wheelX, wheelY, wheelR, 0, Math.PI * 2);
  ctx.fill();
  // Handle — short line angling back toward the dwarf's hands.
  ctx.strokeStyle = "#3a3228";
  ctx.lineWidth = Math.max(1, pt / 16);
  ctx.beginPath();
  ctx.moveTo(tubX, tubY + tubH * 0.5);
  ctx.lineTo(tubX - pt * 0.18, tubY + tubH * 0.1);
  ctx.stroke();
}
