import { ComponentStore, EcsWorld, EntityId } from "../ecs/world";
import { Dwarf, JobAssignment, Needs, Pathing, Position, Item, ItemKind, Carrying, Squad, Equipment, Fury } from "../ecs/components";
import { effectsFor } from "../dwarves/traitEffects";
import { Rng } from "../rng";
import { TileGrid } from "./grid";
import { ColonyPlanner } from "../planner/colonyPlanner";
import { AStar } from "../pathing/astar";
import { EventLog } from "../events/eventLog";
import { TICKS_PER_YEAR } from "../time";
import { Hostile, Health, HOSTILE_DEFS, HostileKind } from "../hostiles/types";
import { SliderState, defaultSliders } from "../sliders";
import { EmergencyState, defaultEmergency } from "../emergency";
import { ResearchState, defaultResearch } from "../research";

const DWARF_BASE_MAX_HP = 100;

export interface Stockpile {
  /** Generic ore tally — any TileType.Ore mined. Later sessions split into
   * iron / copper / silver / gold etc. */
  ore: number;
  /** Stone blocks recovered from Stone / Granite mining. */
  stone: number;
  /** Loose dirt and sand pulled from the Skin layer. Mostly useless
   * structurally but tracked because the dwarves did the work. */
  dirt: number;
  /** Food units. Each meal a dwarf eats consumes 1. Replenished by
   * farming + hauling in a later session; for now the founders bring a
   * sizeable starter cache. */
  food: number;
  /** Drink units (water, ale). Same model as food. */
  drink: number;
  /** Smelted metal bars — output of the Smelter, future input to the
   * Forge. No direct consumer yet beyond the Forge itself. */
  bars: number;
  /** Forged metal tools — pickaxes, axes, etc. No direct consumer yet;
   * future sessions wire them into mining / woodcutting speed bonuses. */
  tools: number;
  /** Cut and rough gems pulled from the Gem Seam. No direct consumer
   * yet — Tier 3 Gem Cutting research turns rough gems into cut gems,
   * Tier 3 Gem Inlay turns those into trade goods. */
  gems: number;
  /** Cooked meals — kitchen output. Restore more hunger than raw food
   * (90 vs 60 per unit). progressEat prefers meals when both are
   * available. */
  meals: number;
}

const STARTER_FOOD = 1000;
const STARTER_DRINK = 1000;

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
  readonly hostile: ComponentStore<Hostile>;
  readonly health: ComponentStore<Health>;
  readonly item: ComponentStore<Item>;
  readonly carrying: ComponentStore<Carrying>;
  readonly squad: ComponentStore<Squad>;
  readonly equipment: ComponentStore<Equipment>;
  readonly fury: ComponentStore<Fury>;

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
  readonly stockpile: Stockpile = {
    ore: 0,
    stone: 0,
    dirt: 0,
    food: STARTER_FOOD,
    drink: STARTER_DRINK,
    bars: 0,
    tools: 0,
    gems: 0,
    meals: 0,
  };

  // True once the colony has hit its first ore tile. Used to fire a one-
  // time discovery event the next time a dwarf strikes ore.
  oreEverStruck = false;

  /** Last in-game year for which a year-rollover event was emitted. */
  lastYearAnnounced = 0;

  /** Population thresholds that have already been announced as milestones. */
  populationMilestones: Set<number> = new Set();

  /** GDD §10.2 named milestones already announced — "The First Hearth",
   * "Iron Mountain", "The First Diamond", etc. Each is one-shot per
   * fortress. Round-trips through save so a reload doesn't replay them. */
  narrativeMilestones: Set<string> = new Set();

  /** Player-tweakable priority sliders (GDD §4.1). Mutated directly by the
   * UI; read by chooseTask each tick. Round-trips through save. */
  sliders: SliderState = defaultSliders();

  /** Active emergency mode (GDD §4.3) plus cooldown bookkeeping. Same
   * mutate-from-UI, read-from-sim contract as `sliders`. */
  emergency: EmergencyState = defaultEmergency();

  /** Research progress (GDD §10). Tier 1+2 are wired now; deeper tiers
   * arrive when their gates land. */
  research: ResearchState = defaultResearch();

  /** True once any dwarf has stood at depth ≥ 1601 — the moment the
   * Hollow King becomes aware of the colony (GDD §9.4). Gates the
   * nightmare-event cadence and the King's siege escalation. */
  hollowKingAware = false;
  /** Nightmares delivered since the King awoke. Drives the siege
   * escalation: void shades begin appearing once enough dread has
   * accumulated. */
  hollowKingNightmares = 0;
  /** Tick at which the most recent void-shade siege fired. Cooldown
   * keeps the King from sieging continuously. */
  hollowKingLastSiegeTick = 0;
  /** Set once the Hollow King has manifested as a hostile entity —
   * the colony researched his true name (Tier 6) and called him to a
   * fight. Prevents the King from being summoned twice. */
  hollowKingSpawned = false;
  /** Tick at which an aquifer was first breached (GDD §5.2). Drives
   * the flood-spread system and the Aquifer Survived milestone — if
   * the colony lives a week past breach without abandoning, the
   * milestone fires. -1 means no breach has happened yet. */
  aquiferBreachTick = -1;
  /** Number of void shades the colony has put down since the King
   * woke. The Hollow King Falls milestone fires once enough have been
   * cut down — survival, in this game, is the win condition. */
  voidShadesSlain = 0;

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
    this.hostile = new ComponentStore(maxEntities);
    this.health = new ComponentStore(maxEntities);
    this.item = new ComponentStore(maxEntities);
    this.carrying = new ComponentStore(maxEntities);
    this.squad = new ComponentStore(maxEntities);
    this.equipment = new ComponentStore(maxEntities);
    this.fury = new ComponentStore(maxEntities);
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
    /** True iff this dwarf was born in the colony (a real birth, not a
     * founder or migrant). Defaults to false — birthDwarf overrides it
     * to true. Round-trips through save. */
    bornInColony?: boolean;
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
      bornInColony: spec.bornInColony ?? false,
    });
    const effects = effectsFor(spec.traitIds ?? []);
    const maxHp = Math.max(20, Math.round(DWARF_BASE_MAX_HP * effects.hpScale));
    this.health.set(e, { hp: maxHp, maxHp, lastAttackTick: 0 });
    this.needs.set(e, {
      sleep: spec.initialNeeds?.sleep ?? 100,
      social: spec.initialNeeds?.social ?? 100,
      hunger: spec.initialNeeds?.hunger ?? 100,
      thirst: spec.initialNeeds?.thirst ?? 100,
      morale: spec.initialNeeds?.morale ?? effects.moraleBaseline,
      decayAccumSleep: spec.initialNeeds?.decayAccumSleep ?? 0,
      decayAccumSocial: spec.initialNeeds?.decayAccumSocial ?? 0,
      decayAccumHunger: spec.initialNeeds?.decayAccumHunger ?? 0,
      decayAccumThirst: spec.initialNeeds?.decayAccumThirst ?? 0,
      decayAccumMorale: spec.initialNeeds?.decayAccumMorale ?? 0,
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

  /** Drop an item onto the floor at (x, y). Returns the new entity id.
   * Used by the mining work system when a tile is excavated, so the rough
   * stone / ore / dirt becomes a haulable object instead of teleporting
   * straight into the stockpile counter. */
  spawnItem(spec: { kind: ItemKind; x: number; y: number; quality?: number }): EntityId {
    const e = this.ecs.create();
    this.position.set(e, { x: spec.x, y: spec.y });
    this.item.set(e, { kind: spec.kind, claimedBy: -1, quality: spec.quality });
    return e;
  }

  /** Destroy an item entity (after it's hauled into a stockpile). */
  destroyItem(e: EntityId): void {
    this.ecs.destroy(e, [this.position, this.item]);
  }

  /** Reveal the fog-of-war mask around every living dwarf. Used at game
   * start so the spawn cavern is visible before the first tick fires. */
  revealAroundDwarves(radius = 5): void {
    const grid = this.grid;
    const ents = this.dwarf.entities;
    for (let i = 0; i < ents.length; i++) {
      const p = this.position.get(ents[i]);
      if (!p) continue;
      const x0 = Math.max(0, p.x - radius);
      const y0 = Math.max(0, p.y - radius);
      const x1 = Math.min(grid.width - 1, p.x + radius);
      const y1 = Math.min(grid.height - 1, p.y + radius);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - p.x;
          const dy = y - p.y;
          if (dx * dx + dy * dy <= radius * radius) grid.markSeen(x, y);
        }
      }
    }
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

  // ---- Hostile spawning --------------------------------------------------

  /** Spawn a new hostile entity. Returns the new entity id. */
  spawnHostile(spec: {
    kind: HostileKind;
    x: number;
    y: number;
    hp?: number;
    lastAttackTick?: number;
    lastMoveTick?: number;
  }): EntityId {
    const def = HOSTILE_DEFS[spec.kind];
    const e = this.ecs.create();
    this.position.set(e, { x: spec.x, y: spec.y });
    this.hostile.set(e, {
      kind: spec.kind,
      lastAttackTick: spec.lastAttackTick ?? 0,
      lastMoveTick: spec.lastMoveTick ?? 0,
    });
    this.health.set(e, {
      hp: spec.hp ?? def.maxHp,
      maxHp: def.maxHp,
      lastAttackTick: 0,
    });
    return e;
  }
}
