import { ComponentStore, EcsWorld, EntityId } from "../ecs/world";
import { Dwarf, JobAssignment, Pathing, Position } from "../ecs/components";
import { Rng } from "../rng";
import { TileGrid } from "./grid";
import { DigZones } from "./digZones";
import { AStar } from "../pathing/astar";

/**
 * Aggregate of everything the deterministic tick function needs. The same
 * SimWorld instance is constructed in the main thread and in the catch-up
 * worker; only the renderer reads it on the main thread.
 */
export class SimWorld {
  readonly seed: number;
  readonly grid: TileGrid;
  readonly ecs: EcsWorld;
  readonly digZones = new DigZones();
  readonly astar: AStar;

  // Component stores.
  readonly position: ComponentStore<Position>;
  readonly dwarf: ComponentStore<Dwarf>;
  readonly pathing: ComponentStore<Pathing>;
  readonly job: ComponentStore<JobAssignment>;

  // Forked RNG streams.
  readonly aiRng: Rng;
  readonly worldRng: Rng;

  // Total ticks elapsed (kept here so the worker doesn't need a separate clock).
  tick = 0;

  // Surface heightmap, retained from worldgen for rendering & gameplay.
  readonly surfaceY: Int32Array;

  // Spawn point.
  readonly spawn: { x: number; y: number };

  constructor(seed: number, grid: TileGrid, surfaceY: Int32Array, spawn: { x: number; y: number }, maxEntities = 4096) {
    this.seed = seed;
    this.grid = grid;
    this.surfaceY = surfaceY;
    this.spawn = spawn;
    this.ecs = new EcsWorld(maxEntities);
    this.position = new ComponentStore(maxEntities);
    this.dwarf = new ComponentStore(maxEntities);
    this.pathing = new ComponentStore(maxEntities);
    this.job = new ComponentStore(maxEntities);
    const root = Rng.fromSeed(seed);
    this.aiRng = root.fork("ai");
    this.worldRng = root.fork("world");
    this.astar = new AStar(grid.width, grid.height);
  }

  spawnDwarf(name: string, x: number, y: number): EntityId {
    const e = this.ecs.create();
    this.position.set(e, { x, y });
    this.dwarf.set(e, { name, lastJobTick: 0 });
    return e;
  }

  /**
   * Iterate dwarves in deterministic order — sparse-set dense array order.
   */
  forEachDwarf(fn: (id: EntityId, pos: Position, dw: Dwarf) => void): void {
    const ents = this.dwarf.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const pos = this.position.get(e);
      const dw = this.dwarf.get(e);
      if (pos && dw) fn(e, pos, dw);
    }
  }
}
