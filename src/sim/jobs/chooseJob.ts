import { SimWorld } from "../world/simWorld";

// BFS outward from a dwarf to find the nearest reachable solid tile that is
// claimed by an active blueprint AND has at least one walkable neighbor (so a
// dwarf can stand next to it). Tiles outside any blueprint are ignored —
// dwarves never strip-mine: they only excavate what the Colony Planner has
// committed the colony to. Determinism: neighbor expansion order is fixed,
// ties broken by (y, x) and then by best-distance preservation.

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

export interface JobTarget {
  x: number;
  y: number;
}

export function findMineTarget(sim: SimWorld, sx: number, sy: number, maxNodes = 4000): JobTarget | null {
  const grid = sim.grid;
  if (!grid.inBounds(sx, sy)) return null;
  if (!sim.planner.hasActive()) return null;

  // Generation-counter "seen" map: Int32Array can hold 2^31 generations before
  // wrapping, so resets are effectively never needed.
  if (!sim.scratchSeen || sim.scratchSeen.length !== grid.width * grid.height) {
    sim.scratchSeen = new Int32Array(grid.width * grid.height);
    sim.scratchSeenGen = 0;
  }
  const seen = sim.scratchSeen;
  sim.scratchSeenGen = (sim.scratchSeenGen ?? 0) + 1;
  const gen = sim.scratchSeenGen;

  if (!sim.scratchQueue || sim.scratchQueue.length < maxNodes * 4 + 16) {
    sim.scratchQueue = new Int32Array(maxNodes * 4 + 16);
  }
  const queue = sim.scratchQueue;
  let qHead = 0;
  let qTail = 0;

  const w = grid.width;
  const startIdx = sy * w + sx;
  seen[startIdx] = gen;
  queue[qTail++] = startIdx;

  let bestX = -1;
  let bestY = -1;
  let bestDist = Infinity;
  let visited = 0;

  while (qHead < qTail && visited < maxNodes) {
    const idx = queue[qHead++];
    const cx = idx % w;
    const cy = (idx / w) | 0;
    visited++;

    for (let i = 0; i < 4; i++) {
      const nx = cx + DX[i];
      const ny = cy + DY[i];
      if (!grid.inBounds(nx, ny)) continue;
      const nIdx = ny * w + nx;
      if (seen[nIdx] === gen) continue;
      seen[nIdx] = gen;

      if (grid.isSolid(nx, ny)) {
        // Solid neighbor: candidate target only if it's inside an active
        // blueprint AND (cx, cy) is a walkable spot the dwarf can stand on.
        if (!sim.planner.containsTile(grid, nx, ny)) continue;
        if (grid.isWalkable(cx, cy)) {
          const dx = nx - sx;
          const dy = ny - sy;
          const dist = dx * dx + dy * dy;
          if (
            dist < bestDist ||
            (dist === bestDist && (ny < bestY || (ny === bestY && nx < bestX)))
          ) {
            bestX = nx;
            bestY = ny;
            bestDist = dist;
          }
        }
        continue;
      }

      if (grid.isWalkable(nx, ny)) {
        if (qTail < queue.length) queue[qTail++] = nIdx;
      }
    }

    // BFS expands in concentric rings; once any candidate is found, give the
    // current ring a chance to finish (cheap), then stop.
    if (bestX !== -1 && visited > 96) break;
  }

  if (bestX === -1) return null;
  return { x: bestX, y: bestY };
}

declare module "../world/simWorld" {
  interface SimWorld {
    scratchSeen?: Int32Array;
    scratchSeenGen?: number;
    scratchQueue?: Int32Array;
  }
}
