import { SimWorld } from "./world/simWorld";
import { chooseTask } from "./jobs/chooseTask";
import { TileType } from "./world/tiles";
import { unpackCell } from "./pathing/astar";
import { JobAssignment, Pathing } from "./ecs/components";
import { EntityId } from "./ecs/world";
import { narrateOreFirstStrike } from "./events/narrator";

// One in-game minute = MOVE_TICKS to step one tile, MINE_TICKS to break a tile.
// Tuning is intentionally fast for early sessions so behavior is visible.
export const MOVE_TICKS = 1;
export const MINE_TICKS = 6;
export const SLEEP_TICKS = 240; // 4 in-game hours of rest restores 80 sleep
export const SOCIALISE_TICKS = 30; // half an in-game hour of conversation
export const WANDER_LINGER_TICKS = 12; // after arrival, pause briefly before next task

// Need decay rates: units lost per tick. Stored as 1/RATE so we can use the
// per-need accumulator pattern without floating-point determinism worries.
const SLEEP_DECAY_TICKS_PER_UNIT = 30; // 100 → 0 over ~3000 ticks (~50h)
const SOCIAL_DECAY_TICKS_PER_UNIT = 60; // 100 → 0 over ~6000 ticks (~100h)

/**
 * Single deterministic tick. Used by both the main thread game loop and the
 * catch-up worker — the only difference between live play and catch-up is
 * whether a renderer reads the world after the tick.
 */
export function tick(sim: SimWorld): void {
  sim.tick++;
  // Order matters for determinism. Each system iterates entities via sparse-set
  // dense arrays so iteration order is deterministic.
  sim.planner.tick({
    grid: sim.grid,
    spawn: sim.spawn,
    tick: sim.tick,
    population: sim.dwarf.size(),
    rng: sim.plannerRng,
    events: sim.events,
  });
  needsSystem(sim);
  jobAssignmentSystem(sim);
  movementSystem(sim);
  workSystem(sim);
}

/**
 * Decay each dwarf's needs by integer increments per tick. Uses an
 * accumulator on the Needs component so decay rate isn't tied to integer
 * tick counts and stays deterministic.
 */
function needsSystem(sim: SimWorld): void {
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const n = sim.needs.get(e);
    if (!n) continue;
    n.decayAccumSleep++;
    n.decayAccumSocial++;
    if (n.decayAccumSleep >= SLEEP_DECAY_TICKS_PER_UNIT) {
      n.sleep = Math.max(0, n.sleep - 1);
      n.decayAccumSleep -= SLEEP_DECAY_TICKS_PER_UNIT;
    }
    if (n.decayAccumSocial >= SOCIAL_DECAY_TICKS_PER_UNIT) {
      n.social = Math.max(0, n.social - 1);
      n.decayAccumSocial -= SOCIAL_DECAY_TICKS_PER_UNIT;
    }
  }
}

/** For each idle dwarf, run chooseTask and assign the resulting job + path. */
function jobAssignmentSystem(sim: SimWorld): void {
  const dwarves = sim.dwarf.entities;
  for (let i = 0; i < dwarves.length; i++) {
    const e = dwarves[i];
    if (sim.job.has(e)) continue;
    const pos = sim.position.get(e);
    if (!pos) continue;

    const proposal = chooseTask(sim, e);
    if (!proposal) continue;

    // Plan a path appropriate for the kind of job.
    let path: Int32Array | null = null;
    if (proposal.kind === "mine") {
      path = sim.astar.findPathToNeighbor(sim.grid, pos.x, pos.y, proposal.targetX, proposal.targetY, 6000);
    } else {
      // Sleep / socialise / wander all walk *to* a walkable tile, not adjacent.
      path = sim.astar.findPath(sim.grid, pos.x, pos.y, proposal.targetX, proposal.targetY, 6000);
      // For socialise: if the partner moved between proposal and now, allow
      // adjacency to count (try neighbor pathfinding as fallback).
      if (!path && proposal.kind === "socialise") {
        path = sim.astar.findPathToNeighbor(sim.grid, pos.x, pos.y, proposal.targetX, proposal.targetY, 6000);
      }
    }
    if (!path) continue;

    const pathing: Pathing = { path, pathIndex: 0, goalX: proposal.targetX, goalY: proposal.targetY };
    sim.job.set(e, proposal);
    sim.pathing.set(e, pathing);
    if (proposal.kind === "mine") {
      sim.claimMineTarget(proposal.targetX, proposal.targetY);
    }
  }
}

/** Walk dwarves along their assigned paths one tile per tick. */
function movementSystem(sim: SimWorld): void {
  const pathingEnts = sim.pathing.entities;
  for (let i = 0; i < pathingEnts.length; i++) {
    const e = pathingEnts[i];
    const path = sim.pathing.get(e)!;
    const pos = sim.position.get(e)!;

    if (path.pathIndex >= path.path.length - 1) continue;

    // Replan if the next step became unwalkable since the path was planned.
    const nextCell = unpackCell(path.path[path.pathIndex + 1]);
    if (!sim.grid.isWalkable(nextCell.x, nextCell.y)) {
      const job = sim.job.get(e);
      if (job?.kind === "mine") sim.releaseMineTarget(job.targetX, job.targetY);
      sim.pathing.remove(e);
      sim.job.remove(e);
      continue;
    }

    path.pathIndex++;
    pos.x = nextCell.x;
    pos.y = nextCell.y;
  }
}

/** Execute the dwarf's current job once they've arrived. Dispatch by kind. */
function workSystem(sim: SimWorld): void {
  const jobEnts = sim.job.entities;
  // Iterate backwards so removals don't disturb iteration.
  for (let i = jobEnts.length - 1; i >= 0; i--) {
    const e = jobEnts[i];
    const job = sim.job.get(e)!;
    const pos = sim.position.get(e)!;
    const path = sim.pathing.get(e);

    // Wait until the dwarf finished walking.
    if (path && path.pathIndex < path.path.length - 1) continue;

    switch (job.kind) {
      case "mine":
        progressMine(sim, e, job, pos);
        break;
      case "sleep":
        progressSleep(sim, e, job);
        break;
      case "socialise":
        progressSocialise(sim, e, job);
        break;
      case "wander":
        progressWander(sim, e, job);
        break;
    }
  }
}

function progressMine(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  // Adjacency check.
  const dx = Math.abs(pos.x - job.targetX);
  const dy = Math.abs(pos.y - job.targetY);
  if (dx > 1 || dy > 1) {
    sim.releaseMineTarget(job.targetX, job.targetY);
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  if (!sim.grid.isSolid(job.targetX, job.targetY)) {
    sim.releaseMineTarget(job.targetX, job.targetY);
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  job.progress++;
  if (job.progress >= MINE_TICKS) {
    // What was the rock made of? Determines stockpile credit.
    const tileType = sim.grid.getTile(job.targetX, job.targetY);
    sim.grid.setTile(job.targetX, job.targetY, TileType.CorridorFloor);
    sim.grid.setDesignation(job.targetX, job.targetY, 0);
    sim.releaseMineTarget(job.targetX, job.targetY);

    // Stockpile credit + first-strike narration. Real workshops in a later
    // session refine these into bars/blocks/etc.
    if (tileType === TileType.Ore) {
      sim.stockpile.ore++;
      if (!sim.oreEverStruck) {
        sim.oreEverStruck = true;
        const dw = sim.dwarf.get(e)!;
        sim.events.add(
          sim.tick,
          "discovery",
          narrateOreFirstStrike(sim.plannerRng, dw.name, job.targetY, sim.spawn.y),
        );
      }
    } else if (tileType === TileType.Stone || tileType === TileType.Granite) {
      sim.stockpile.stone++;
    } else if (tileType === TileType.Dirt || tileType === TileType.Sand) {
      sim.stockpile.dirt++;
    }

    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressSleep(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  const needs = sim.needs.get(e);
  if (!needs) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  job.progress++;
  // Restore +1 sleep every 3 ticks of rest (so 240 ticks → +80).
  if (job.progress % 3 === 0) {
    needs.sleep = Math.min(100, needs.sleep + 1);
  }
  if (job.progress >= SLEEP_TICKS || needs.sleep >= 95) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressSocialise(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  const myNeeds = sim.needs.get(e);
  if (!myNeeds) {
    sim.job.remove(e);
    sim.pathing.remove(e);
    return;
  }
  job.progress++;
  // Both dwarves gain social each tick of conversation.
  myNeeds.social = Math.min(100, myNeeds.social + 2);
  if (job.partnerId !== undefined) {
    const partnerNeeds = sim.needs.get(job.partnerId);
    if (partnerNeeds) partnerNeeds.social = Math.min(100, partnerNeeds.social + 2);
  }
  if (job.progress >= SOCIALISE_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}

function progressWander(sim: SimWorld, e: EntityId, job: JobAssignment): void {
  // Already at destination by virtue of getting here; linger briefly so the
  // dwarf isn't reassigned the same tick they arrived.
  job.progress++;
  if (job.progress >= WANDER_LINGER_TICKS) {
    sim.dwarf.get(e)!.lastJobTick = sim.tick;
    sim.job.remove(e);
    sim.pathing.remove(e);
  }
}
