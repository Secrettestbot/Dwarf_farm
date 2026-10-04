// Stranded dwarves: a dwarf whose own tile stops being walkable (a
// flood spreading over them, a barred door or sealed entrance closing
// on them) can no longer plan any path — A* refuses a non-walkable
// start — so without help they stand idle until thirst kills them,
// even beside a full cellar. This system wades them out: each tick a
// stranded dwarf steps one tile toward the nearest walkable floor,
// moving through open (non-solid) tiles such as water.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { dropJob } from "./shared";

/** How far (in tiles) a stranded dwarf will search for dry floor. */
const WADE_SEARCH_RADIUS = 12;

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/** First step from (sx, sy) toward the nearest walkable tile, moving
 * only through non-solid tiles. Null when nothing is within range. */
export function wadeStep(sim: SimWorld, sx: number, sy: number): { x: number; y: number } | null {
  const grid = sim.grid;
  const side = WADE_SEARCH_RADIUS * 2 + 1;
  const parent = new Int32Array(side * side).fill(-2);
  const idx = (x: number, y: number) => (y - sy + WADE_SEARCH_RADIUS) * side + (x - sx + WADE_SEARCH_RADIUS);
  const queue: number[] = [sx, sy];
  parent[idx(sx, sy)] = -1;
  for (let q = 0; q < queue.length; q += 2) {
    const x = queue[q];
    const y = queue[q + 1];
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (Math.abs(nx - sx) > WADE_SEARCH_RADIUS || Math.abs(ny - sy) > WADE_SEARCH_RADIUS) continue;
      if (!grid.inBounds(nx, ny) || grid.isSolid(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (parent[ni] !== -2) continue;
      parent[ni] = idx(x, y);
      if (grid.isWalkable(nx, ny)) {
        // Walk back to the step adjacent to the start.
        let cur = ni;
        while (parent[cur] !== idx(sx, sy)) cur = parent[cur];
        return {
          x: (cur % side) - WADE_SEARCH_RADIUS + sx,
          y: Math.floor(cur / side) - WADE_SEARCH_RADIUS + sy,
        };
      }
      queue.push(nx, ny);
    }
  }
  return null;
}

export function strandedSystem(sim: SimWorld): void {
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const e: EntityId = ents[i];
    const pos = sim.position.get(e);
    if (!pos || sim.grid.isWalkable(pos.x, pos.y)) continue;
    const step = wadeStep(sim, pos.x, pos.y);
    if (!step) continue;
    if (sim.job.has(e)) dropJob(sim, e);
    pos.x = step.x;
    pos.y = step.y;
  }
}
