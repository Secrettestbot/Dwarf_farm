import { ComponentStore, EcsWorld, EntityId } from "../ecs/world";
import { Dwarf, JobAssignment, Needs, Pathing, Position } from "../ecs/components";
import { Rng } from "../rng";
import { TileGrid } from "./grid";
import { ColonyPlanner } from "../planner/colonyPlanner";
import { AStar } from "../pathing/astar";
import { EventLog } from "../events/eventLog";
import { TICKS_PER_YEAR } from "../time";

export interface Stockpile {
  /** Generic ore tally — any TileType.Ore mined. Later sessions split into
   * iron / copper / silver / gold etc. */
  ore: number;
  /** Stone blocks recovered from Stone / Granite mining. */
  stone: number;
  /** Loose dirt and sand pulled from the Skin layer. Mostly useless
   * structurally but tracked because the dwarves did the work. */
  dirt: number;
}

/**
 * Aggregate of everything the deterministic tick function needs. The same
 * SimWorld instance is constructed in the main thread and in the catch-up
 * worker; only the renderer reads it on the main thread.
 */
export class SimWorld {
  readonly seed: number;
  readonly grid: TileGrid;
  readonly ecs: EcsWorld;
  readonly planner = new ColonyPlanner();
  readonly astar: AStar;

  // Component stores.
  readonly position: ComponentStore<Position>;
  readonly dwarf: ComponentStore<Dwarf>;
  readonly pathing: ComponentStore<Pathing>;
  readonly job: ComponentStore<JobAssignment>;
  readonly needs: ComponentStore<Needs>;

  // Forked RNG streams.
  readonly aiRng: Rng;
  readonly worldRng: Rng;
  readonly plannerRng: Rng;

  // Mining-target claims keyed by packed (y << 16 | x). Cleared when the
  // owning dwarf's mine job is removed (success, abort, or replan). Without
  // this, every idle dwarf's chooseTask BFS finds the same nearest tile and
  // all 7 founders pile onto a single mining target — defeating the point
  // of having several dwarves at all.
  readonly mineClaims: Set<number> = new Set();

  // Player's reading material. Every meaningful sim event lands here.
  readonly events = new EventLog();

  // Resource accumulation — a real stockpile system with workshops arrives
  // in a later session, but tracking what's been pulled from the rock now
  // gives the player something concrete to watch grow.
  readonly stockpile: Stockpile = { ore: 0, stone: 0, dirt: 0 };

  // True once the colony has hit its first ore tile. Used to fire a one-
  // time discovery event the next time a dwarf strikes ore.
  oreEverStruck = false;

  /** Last in-game year for which a year-rollover event was emitted. */
  lastYearAnnounced = 0;

  /** Population thresholds that have already been announced as milestones. */
  populationMilestones: Set<number> = new Set();

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
    this.needs = new ComponentStore(maxEntities);
    const root = Rng.fromSeed(seed);
    this.aiRng = root.fork("ai");
    this.worldRng = root.fork("world");
    this.plannerRng = root.fork("planner");
    this.astar = new AStar(grid.width, grid.height);
  }

  spawnDwarf(spec: {
    name: string;
    x: number;
    y: number;
    traitIds?: string[];
    skills?: import("../dwarves/skills").SkillLevels;
    skillXp?: import("../dwarves/skillProgress").SkillXp;
    profession?: string;
    age?: number;
    /** Optional explicit bornAtTick — used by save/restore. Otherwise we
     * compute it from age + current tick so a freshly-spawned dwarf with
     * age 25 has bornAtTick = sim.tick - 25 × TICKS_PER_YEAR. */
    bornAtTick?: number;
    initialNeeds?: Partial<Needs>;
  }): EntityId {
    const e = this.ecs.create();
    this.position.set(e, { x: spec.x, y: spec.y });
    const age = spec.age ?? 25;
    const bornAtTick = spec.bornAtTick ?? this.tick - age * TICKS_PER_YEAR;
    this.dwarf.set(e, {
      name: spec.name,
      traitIds: spec.traitIds ?? [],
      skills: spec.skills ?? {},
      skillXp: spec.skillXp ?? {},
      profession: spec.profession ?? "Worker",
      bornAtTick,
      partnerId: null,
      lastJobTick: 0,
    });
    this.needs.set(e, {
      sleep: spec.initialNeeds?.sleep ?? 100,
      social: spec.initialNeeds?.social ?? 100,
      decayAccumSleep: spec.initialNeeds?.decayAccumSleep ?? 0,
      decayAccumSocial: spec.initialNeeds?.decayAccumSocial ?? 0,
    });
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

  /** Find the dwarf standing on (x, y), or null. Used for click-inspect. */
  dwarfAt(x: number, y: number): EntityId | null {
    const ents = this.dwarf.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const p = this.position.get(e);
      if (p && p.x === x && p.y === y) return e;
    }
    return null;
  }

  /** Compute a dwarf's current age in in-game years. */
  ageOf(e: EntityId): number {
    const dw = this.dwarf.get(e);
    if (!dw) return 0;
    return Math.max(0, Math.floor((this.tick - dw.bornAtTick) / TICKS_PER_YEAR));
  }

  // ---- Mining claim helpers (dwarves disperse to different targets) ------

  claimMineTarget(x: number, y: number): void {
    this.mineClaims.add((y << 16) | x);
  }

  releaseMineTarget(x: number, y: number): void {
    this.mineClaims.delete((y << 16) | x);
  }

  isMineClaimed(x: number, y: number): boolean {
    return this.mineClaims.has((y << 16) | x);
  }
}
