import { ComponentStore, EcsWorld, EntityId } from "../ecs/world";
import { Dwarf, JobAssignment, Needs, Pathing, Position, Item, ItemKind, Carrying, Squad, Equipment, Fury, Obsession, Tantrum, Pet, Disease } from "../ecs/components";
import { effectsFor } from "../dwarves/traitEffects";
import { Rng } from "../rng";
import { TileGrid } from "./grid";
import { ColonyPlanner } from "../planner/colonyPlanner";
import { AStar } from "../pathing/astar";
import { RegionMap } from "../pathing/regionMap";
import { EventLog } from "../events/eventLog";
import { TICKS_PER_YEAR } from "../time";
import { Hostile, Health, HOSTILE_DEFS, HostileKind } from "../hostiles/types";
import { SliderState, defaultSliders } from "../sliders";
import { EmergencyState, defaultEmergency } from "../emergency";
import { ResearchState, defaultResearch } from "../research";

const DWARF_BASE_MAX_HP = 100;

/** A buried dwarf in the colony cemetery. The Headstone tile at
 * (x, y) renders the gravestone visually; this record is what the
 * inspector + chronicle use when a survivor visits or remembers. */
export interface Grave {
  x: number;
  y: number;
  name: string;
  profession: string;
  ageAtDeath: number;
  deathTick: number;
  cause: string;
}

/** A named artifact in the colony's history — a Masterwork item
 * sufficiently extraordinary that the colony gave it a name. The
 * underlying item entity may have been hauled, consumed, equipped,
 * or destroyed; the artifact record persists as chronicle. */
export interface Artifact {
  id: number;
  name: string;
  /** Item-kind label shown in the chronicle ("an iron pickaxe"). */
  kindLabel: string;
  makerName: string;
  makerProfession: string;
  createdTick: number;
}

/** A book written by a scholar in the library when a research topic
 * completes. The colony's accumulated body of work — future
 * scholarship draws on it. */
export interface Book {
  title: string;
  topicId: string;
  authorName: string;
  writtenAtTick: number;
}

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
  /** Cut stone blocks — Mason's Workshop output (GDD §8.2). Used by
   * future masonry & mortaring research to build constructed walls /
   * fortifications; for now just accumulates as a counter. */
  blocks: number;
  /** Cut gems — Jeweller's Workshop output (GDD §10.2 Tier 3 Gem
   * Cutting). Trade-good with no in-game consumer yet beyond the
   * trade caravan. */
  cut_gems: number;
  /** Loose wood logs — output of logging surface trees, future input
   * to the Carpenter's Workshop. Counter mirrors what's in the
   * stockpile after haulers deposit logs. */
  wood: number;
  /** Sawn planks — Carpenter's Workshop output (GDD §7.1). Future
   * construction material; for now just accumulates. */
  planks: number;
  /** Fired pottery — Kiln output (GDD §10.2 Tier 2 Pottery & Kilns).
   * Trade-good with no in-game consumer yet beyond accumulating. */
  pots: number;
  /** Raw hides — dropped by larger hostiles when slain. Hauled to a
   * Tannery and tanned into leather. */
  hide: number;
  /** Tanned leather — Tannery output. Future input for armouring and
   * trade goods. */
  leather: number;
  /** Rope fibre — accumulated by farms as a rare side-yield, future
   * input for Loom (cloth) and Carpentry: Mechanisms (Tier 2). */
  rope: number;
  /** Woven cloth — Loom output. Future input for trade goods, soft
   * furnishings, and tier-2 medicine bandages. */
  cloth: number;
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
  /** Coarse-grained region map — pairs with AStar to fast-fail
   * pathfinds whose start and goal lie in disconnected walkable
   * regions. Invalidated whenever walkable space changes (mining,
   * flooding, doors barring). */
  readonly regions: RegionMap;

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
  readonly obsession: ComponentStore<Obsession>;
  readonly tantrum: ComponentStore<Tantrum>;
  readonly pet: ComponentStore<Pet>;
  readonly disease: ComponentStore<Disease>;

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
    blocks: 0,
    cut_gems: 0,
    wood: 0,
    planks: 0,
    pots: 0,
    hide: 0,
    leather: 0,
    rope: 0,
    cloth: 0,
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

  /** Caravan-on-site marker. While set, the renderer draws a trader
   * pip at the recorded tile and the chronicle reads as "the wagons
   * are still here". Cleared when the caravan despawns at
   * caravanLeavesTick. tick=-1 means no caravan present. */
  caravanX = 0;
  caravanY = 0;
  caravanLeavesTick = -1;
  /** Origin kingdom of the caravan currently on site, for inspector
   * display. Empty when no caravan is present. */
  caravanOrigin = "";

  /** Cemetery registry — every dwarf interred in a Headstone tile,
   * with the details a survivor would speak at the grave. Round-trips
   * through save so a reload restores the colony's full memorial roll
   * call. */
  graves: Grave[] = [];

  /** Notable artifacts registry — when a Legendary crafter produces
   * a Masterwork the colony occasionally names the result and adds
   * it to this list. Pure history: the chronicle references entries
   * by id, the throne-room display reads it, but the simulation
   * itself doesn't gate on artifacts. */
  artifacts: Artifact[] = [];
  artifactsNextId = 1;

  /** Library registry — when research completes, the scholar who
   * finished it writes a book about the topic. Pure history: future
   * scholars who study at a desk get a small XP boost based on the
   * library's size, and the inspector shows a "Library: N books"
   * line. */
  books: Book[] = [];

  /** Name of the colony's currently-recognised Mayor, or empty
   * string if none. Picked annually from the dwarf with the
   * highest leadership skill ≥ 5; their presence anywhere on the
   * map gives a small fortress-wide morale aura. */
  mayorName = "";

  /** Name of the colony's current King — emerges once the colony
   * reaches royal size (pop ≥ KING_POPULATION_THRESHOLD) and a
   * Throne Room exists. Picked from the dwarf with the highest
   * combined leadership + military skill. The King's presence
   * gives the entire fortress a stronger morale aura than the
   * Mayor and the chronicle marks each succession. */
  kingName = "";
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
    this.obsession = new ComponentStore(maxEntities);
    this.tantrum = new ComponentStore(maxEntities);
    this.pet = new ComponentStore(maxEntities);
    this.disease = new ComponentStore(maxEntities);
    const root = Rng.fromSeed(seed);
    this.aiRng = root.fork("ai");
    this.worldRng = root.fork("world");
    this.plannerRng = root.fork("planner");
    this.astar = new AStar(grid.width, grid.height);
    this.regions = new RegionMap(grid.width, grid.height);
    this.astar.regions = this.regions;
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
    /** Names of mother and father — stored on the Dwarf for the
     * inspector to render the family tree. Founders / migrants leave
     * this undefined. */
    parentNames?: [string, string];
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
      parentNames: spec.parentNames,
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
   * start so the spawn cavern is visible before the first tick fires.
   * Per-dwarf radius is read by the live visibility system; this
   * helper takes a flat radius for the one-shot reveal. */
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

  spawnPet(spec: {
    kind: import("../ecs/components").PetKind;
    x: number;
    y: number;
    ownerId?: number;
    ownerName?: string;
    tameProgress?: number;
    tamedAtTick?: number;
    hp?: number;
    maxHp?: number;
  }): EntityId {
    const e = this.ecs.create();
    this.position.set(e, { x: spec.x, y: spec.y });
    this.pet.set(e, {
      kind: spec.kind,
      ownerId: spec.ownerId ?? -1,
      ownerName: spec.ownerName,
      tameProgress: spec.tameProgress ?? 0,
      tamedAtTick: spec.tamedAtTick ?? -1,
      lastAttackTick: 0,
    });
    const maxHp = spec.maxHp ?? 35;
    this.health.set(e, {
      hp: spec.hp ?? maxHp,
      maxHp,
      lastAttackTick: 0,
    });
    return e;
  }

  destroyPet(e: EntityId): void {
    this.ecs.destroy(e, [this.position, this.pet, this.health]);
  }
}
