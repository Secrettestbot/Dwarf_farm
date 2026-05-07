import { SimWorld } from "./world/simWorld";
import { findMineTarget } from "./jobs/chooseJob";
import { TileType } from "./world/tiles";
import { unpackCell } from "./pathing/astar";
import { Pathing, JobAssignment } from "./ecs/components";

// One in-game minute = MOVE_TICKS to step one tile, MINE_TICKS to break a tile.
// Tuning is intentionally fast for session 1 so behavior is visible.
export const MOVE_TICKS = 1; // 1 tile per minute (a brisk dwarven walk)
export const MINE_TICKS = 6; // 6 minutes to break a stone tile

/**
 * Single deterministic tick. Used by both the main thread game loop and the
 * catch-up worker — the only difference between live play and catch-up is
 * whether a renderer reads the world after the tick.
 */
export function tick(sim: SimWorld): void {
  sim.tick++;
  // Systems run in fixed order. Each one iterates entities via sparse-set dense
  // arrays, so iteration order is deterministic.
  // Planner runs first: it can emit new blueprints based on the colony's
  // current state, and chooseJob picks targets from the active blueprint set
  // immediately afterwards.
  sim.planner.tick({
    grid: sim.grid,
    spawn: sim.spawn,
    tick: sim.tick,
    population: sim.dwarf.size(),
  });
  jobAssignmentSystem(sim);
  movementSystem(sim);
  miningSystem(sim);
}

/** For each idle dwarf, find a mining target and a path. */
function jobAssignmentSystem(sim: SimWorld): void {
  const dwarves = sim.dwarf.entities;
  for (let i = 0; i < dwarves.length; i++) {
    const e = dwarves[i];
    if (sim.job.has(e)) continue;
    const pos = sim.position.get(e);
    if (!pos) continue;

    const target = findMineTarget(sim, pos.x, pos.y);
    if (!target) continue;

    const path = sim.astar.findPathToNeighbor(sim.grid, pos.x, pos.y, target.x, target.y, 6000);
    if (!path) continue;

    const job: JobAssignment = {
      kind: "mine",
      targetX: target.x,
      targetY: target.y,
      progress: 0,
    };
    const pathing: Pathing = {
      path,
      pathIndex: 0,
      goalX: target.x,
      goalY: target.y,
    };
    sim.job.set(e, job);
    sim.pathing.set(e, pathing);
  }
}

/** Walk dwarves along their assigned paths one tile per MOVE_TICKS ticks. */
function movementSystem(sim: SimWorld): void {
  // MOVE_TICKS=1 → step every tick. Kept as a constant so future tuning won't
  // change determinism if we keep the integer counter.
  const pathingEnts = sim.pathing.entities;
  for (let i = 0; i < pathingEnts.length; i++) {
    const e = pathingEnts[i];
    const path = sim.pathing.get(e)!;
    const pos = sim.position.get(e)!;

    if (path.pathIndex >= path.path.length - 1) continue;

    // If the next tile became unwalkable since the path was planned, replan.
    const nextCell = unpackCell(path.path[path.pathIndex + 1]);
    if (!sim.grid.isWalkable(nextCell.x, nextCell.y)) {
      // Drop the path and let job assignment replan next tick.
      sim.pathing.remove(e);
      sim.job.remove(e);
      continue;
    }

    path.pathIndex++;
    pos.x = nextCell.x;
    pos.y = nextCell.y;
  }
}

/** Once a dwarf is at the end of their path adjacent to the target, mine. */
function miningSystem(sim: SimWorld): void {
  const jobEnts = sim.job.entities;
  // Iterate backwards so removals don't disturb iteration.
  for (let i = jobEnts.length - 1; i >= 0; i--) {
    const e = jobEnts[i];
    const job = sim.job.get(e)!;
    const pos = sim.position.get(e)!;
    const path = sim.pathing.get(e);
    if (job.kind !== "mine") continue;
    // Wait until we've arrived adjacent to the target.
    if (path && path.pathIndex < path.path.length - 1) continue;

    // Adjacency check.
    const dx = Math.abs(pos.x - job.targetX);
    const dy = Math.abs(pos.y - job.targetY);
    if (dx > 1 || dy > 1) {
      // Got separated somehow; drop and replan.
      sim.job.remove(e);
      sim.pathing.remove(e);
      continue;
    }

    if (!sim.grid.isSolid(job.targetX, job.targetY)) {
      // Tile already mined (e.g. by another dwarf). Free up.
      sim.job.remove(e);
      sim.pathing.remove(e);
      continue;
    }

    job.progress++;
    if (job.progress >= MINE_TICKS) {
      sim.grid.setTile(job.targetX, job.targetY, TileType.CorridorFloor);
      sim.grid.setDesignation(job.targetX, job.targetY, 0);
      sim.dwarf.get(e)!.lastJobTick = sim.tick;
      sim.job.remove(e);
      sim.pathing.remove(e);
    }
  }
}
