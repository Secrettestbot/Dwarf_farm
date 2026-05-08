import { SimWorld } from "../sim/world/simWorld";
import { generateWorld } from "../sim/world/worldgen";
import { CURRENT_SAVE_VERSION, SaveV1, SavedBlueprint, SavedDwarf, SavedHostile, GameMode } from "./schema";
import { decodeOverrides, encodeOverrides, encodeSeen, decodeSeen } from "./codec";
import { Blueprint, BlueprintKind } from "../sim/planner/blueprint";

// Serialize / deserialize a SimWorld to/from a SaveV1. The save records only
// what's needed to deterministically reconstruct the simulation: seed, RLE
// delta vs a clean regen, RNG states, the dwarf list with traits/skills, and
// the colony planner state.

export interface SnapshotInput {
  sim: SimWorld;
  slotId: string;
  fortressName: string;
  mode: GameMode;
  cameraX: number;
  cameraY: number;
  zoomIndex: number;
}

export function snapshot(input: SnapshotInput): SaveV1 {
  const baseline = generateWorld({
    seed: input.sim.seed,
    width: input.sim.grid.width,
    height: input.sim.grid.height,
  });
  const overrides = encodeOverrides(input.sim.grid, baseline.grid);

  // Build an entity → dwarves[index] map first so we can encode partnerIndex
  // on socialise jobs without holding entity references in the save.
  const sim = input.sim;
  const entityToIndex = new Map<number, number>();
  let nextIdx = 0;
  sim.forEachDwarf((id) => {
    entityToIndex.set(id, nextIdx++);
  });

  const dwarves: SavedDwarf[] = [];
  sim.forEachDwarf((id, pos, dw) => {
    const n = sim.needs.get(id);
    const j = sim.job.get(id);
    const p = sim.pathing.get(id);
    const savedJob = j
      ? {
          kind: j.kind,
          targetX: j.targetX,
          targetY: j.targetY,
          progress: j.progress,
          partnerIndex: j.partnerId !== undefined ? entityToIndex.get(j.partnerId) : undefined,
        }
      : undefined;
    const savedPathing = p
      ? {
          path: Array.from(p.path),
          pathIndex: p.pathIndex,
          goalX: p.goalX,
          goalY: p.goalY,
        }
      : undefined;
    const partnerIndex = dw.partnerId !== null ? entityToIndex.get(dw.partnerId) ?? null : null;
    const h = sim.health.get(id);
    const carrying = sim.carrying.get(id);
    const squad = sim.squad.get(id);
    const equipment = sim.equipment.get(id);
    dwarves.push({
      name: dw.name,
      x: pos.x,
      y: pos.y,
      traitIds: dw.traitIds,
      skills: dw.skills,
      skillXp: dw.skillXp as Record<string, number>,
      profession: dw.profession,
      bornAtTick: dw.bornAtTick,
      partnerIndex,
      lastJobTick: dw.lastJobTick,
      health: h
        ? { hp: h.hp, maxHp: h.maxHp, lastAttackTick: h.lastAttackTick, wasSevereWound: h.wasSevereWound }
        : undefined,
      needs: n
        ? {
            sleep: n.sleep,
            social: n.social,
            hunger: n.hunger,
            thirst: n.thirst,
            morale: n.morale,
            decayAccumSleep: n.decayAccumSleep,
            decayAccumSocial: n.decayAccumSocial,
            decayAccumHunger: n.decayAccumHunger,
            decayAccumThirst: n.decayAccumThirst,
            decayAccumMorale: n.decayAccumMorale,
          }
        : undefined,
      job: savedJob,
      pathing: savedPathing,
      carrying: carrying ? { kind: carrying.kind } : undefined,
      squad: squad ? { draftedAtTick: squad.draftedAtTick } : undefined,
      equipment: equipment ? { weapon: equipment.weapon } : undefined,
    });
  });

  const planner = input.sim.planner;
  const blueprints: SavedBlueprint[] = planner.blueprints.map((b) => {
    const cells: number[] = new Array(b.cavity.length * 2);
    for (let i = 0; i < b.cavity.length; i++) {
      const c = b.cavity[i];
      cells[i * 2] = c & 0xffff;
      cells[i * 2 + 1] = (c >>> 16) & 0xffff;
    }
    return {
      id: b.id,
      kind: b.kind,
      originX: b.originX,
      originY: b.originY,
      width: b.width,
      height: b.height,
      cells,
      status: b.status,
      priority: b.priority,
      createdTick: b.createdTick,
      cellTendedAt: b.cellTendedAt ? Array.from(b.cellTendedAt) : undefined,
      lastMaintainedTick: b.lastMaintainedTick,
    };
  });

  return {
    version: CURRENT_SAVE_VERSION,
    slotId: input.slotId,
    fortressName: input.fortressName,
    mode: input.mode,
    seed: input.sim.seed,
    width: input.sim.grid.width,
    height: input.sim.grid.height,
    tick: input.sim.tick,
    realTimestampMs: Date.now(),
    rngStates: {
      ai: input.sim.aiRng.serialize(),
      world: input.sim.worldRng.serialize(),
      planner: input.sim.plannerRng.serialize(),
    },
    tileOverrides: overrides,
    seenMask: encodeSeen(input.sim.grid),
    dwarves,
    blueprints,
    plannerNextId: planner.nextId,
    plannerCompleted: planner.completed,
    plannerAccum: (planner as unknown as { accum: number }).accum,
    cameraX: input.cameraX,
    cameraY: input.cameraY,
    zoomIndex: input.zoomIndex,
    events: sim.events.events.map((e) => ({ tick: e.tick, category: e.category, text: e.text })),
    stockpile: {
      ore: sim.stockpile.ore,
      stone: sim.stockpile.stone,
      dirt: sim.stockpile.dirt,
      food: sim.stockpile.food,
      drink: sim.stockpile.drink,
      bars: sim.stockpile.bars,
      tools: sim.stockpile.tools,
      gems: sim.stockpile.gems,
    },
    oreEverStruck: sim.oreEverStruck,
    lastYearAnnounced: sim.lastYearAnnounced,
    populationMilestones: Array.from(sim.populationMilestones),
    hostiles: collectHostiles(sim),
    sliders: { ...sim.sliders },
    emergency: { ...sim.emergency },
    items: collectItems(sim),
    research: {
      current: sim.research.current,
      progress: sim.research.progress,
      completed: [...sim.research.completed],
    },
    hollowKingAware: sim.hollowKingAware,
    hollowKingNightmares: sim.hollowKingNightmares,
    hollowKingLastSiegeTick: sim.hollowKingLastSiegeTick,
  };
}

function collectItems(sim: SimWorld): import("./schema").SavedItem[] {
  const out: import("./schema").SavedItem[] = [];
  const ents = sim.item.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const it = sim.item.get(e);
    const p = sim.position.get(e);
    if (!it || !p) continue;
    out.push({ kind: it.kind, x: p.x, y: p.y });
  }
  return out;
}

function collectHostiles(sim: SimWorld): SavedHostile[] {
  const out: SavedHostile[] = [];
  const ents = sim.hostile.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const h = sim.hostile.get(e);
    const p = sim.position.get(e);
    const hp = sim.health.get(e);
    if (!h || !p || !hp) continue;
    out.push({
      kind: h.kind,
      x: p.x,
      y: p.y,
      hp: hp.hp,
      maxHp: hp.maxHp,
      lastAttackTick: h.lastAttackTick,
      lastMoveTick: h.lastMoveTick,
    });
  }
  return out;
}

export function restore(save: SaveV1): SimWorld {
  const w = generateWorld({ seed: save.seed, width: save.width, height: save.height });
  const decoded = decodeOverrides(save.tileOverrides);
  decoded.apply(w.grid);
  if (save.seenMask) {
    decodeSeen(save.seenMask, w.grid);
  } else {
    // v2 saves had no fog of war; treat the whole map as already explored
    // so reloading a pre-fog save doesn't black out the player's fortress.
    for (let y = 0; y < w.grid.height; y++) {
      for (let x = 0; x < w.grid.width; x++) w.grid.markSeen(x, y);
    }
  }

  const sim = new SimWorld(save.seed, w.grid, w.surfaceY, w.spawn);
  sim.tick = save.tick;

  // Restore RNG states.
  const aiState = save.rngStates.ai;
  if (aiState) {
    sim.aiRng.stateHi = aiState[0] >>> 0;
    sim.aiRng.stateLo = aiState[1] >>> 0;
  }
  const worldState = save.rngStates.world;
  if (worldState) {
    sim.worldRng.stateHi = worldState[0] >>> 0;
    sim.worldRng.stateLo = worldState[1] >>> 0;
  }
  const plannerState = save.rngStates.planner;
  if (plannerState) {
    sim.plannerRng.stateHi = plannerState[0] >>> 0;
    sim.plannerRng.stateLo = plannerState[1] >>> 0;
  }

  // Restore dwarves. We spawn them in saved-array order so partnerIndex
  // references resolve to predictable entity ids (the ECS allocates ids
  // sequentially from the free list).
  const spawnedEntities: number[] = [];
  for (const d of save.dwarves) {
    const e = sim.spawnDwarf({
      name: d.name,
      x: d.x,
      y: d.y,
      traitIds: d.traitIds ?? [],
      skills: d.skills ?? {},
      skillXp: d.skillXp as import("../sim/dwarves/skillProgress").SkillXp | undefined,
      profession: d.profession ?? "Worker",
      // Prefer bornAtTick if present, else compute from legacy `age`.
      bornAtTick: d.bornAtTick,
      age: d.age,
      initialNeeds: d.needs,
    });
    sim.dwarf.get(e)!.lastJobTick = d.lastJobTick ?? 0;
    spawnedEntities.push(e);
  }
  // Re-apply in-flight job + pathing components, plus partnerships, so the
  // worker / next session resumes at exact mid-task state.
  for (let i = 0; i < save.dwarves.length; i++) {
    const d = save.dwarves[i];
    const e = spawnedEntities[i];
    if (d.partnerIndex !== undefined && d.partnerIndex !== null) {
      const dw = sim.dwarf.get(e);
      if (dw) dw.partnerId = spawnedEntities[d.partnerIndex];
    }
    if (d.job) {
      const partnerId = d.job.partnerIndex !== undefined ? spawnedEntities[d.job.partnerIndex] : undefined;
      sim.job.set(e, {
        kind: d.job.kind,
        targetX: d.job.targetX,
        targetY: d.job.targetY,
        progress: d.job.progress,
        partnerId,
      });
      if (d.job.kind === "mine") {
        sim.claimMineTarget(d.job.targetX, d.job.targetY);
      }
    }
    if (d.pathing) {
      sim.pathing.set(e, {
        path: Int32Array.from(d.pathing.path),
        pathIndex: d.pathing.pathIndex,
        goalX: d.pathing.goalX,
        goalY: d.pathing.goalY,
      });
    }
    if (d.carrying) {
      sim.carrying.set(e, { kind: d.carrying.kind });
    }
    if (d.squad) {
      sim.squad.set(e, { draftedAtTick: d.squad.draftedAtTick });
    }
    if (d.equipment) {
      sim.equipment.set(e, { weapon: d.equipment.weapon });
    }
  }

  // Restore Colony Planner.
  const blueprints: Blueprint[] = (save.blueprints ?? []).map((b) => {
    const cavity = new Int32Array(b.cells.length / 2);
    for (let i = 0; i < cavity.length; i++) {
      const x = b.cells[i * 2];
      const y = b.cells[i * 2 + 1];
      cavity[i] = (y << 16) | x;
    }
    return {
      id: b.id,
      kind: b.kind as BlueprintKind,
      originX: b.originX,
      originY: b.originY,
      width: b.width,
      height: b.height,
      cavity,
      status: b.status,
      priority: b.priority,
      createdTick: b.createdTick,
      cellTendedAt: b.cellTendedAt ? Int32Array.from(b.cellTendedAt) : undefined,
      lastMaintainedTick: b.lastMaintainedTick,
    };
  });
  sim.planner.blueprints = blueprints;
  sim.planner.nextId = save.plannerNextId ?? blueprints.reduce((m, b) => Math.max(m, b.id + 1), 1);
  sim.planner.completed = save.plannerCompleted ?? blueprints.filter((b) => b.status === "complete").length;
  (sim.planner as unknown as { accum: number }).accum = save.plannerAccum ?? 0;
  sim.planner.rehydrate(sim.grid);

  // Event log + stockpile.
  if (save.events) {
    for (const e of save.events) {
      sim.events.events.push({
        tick: e.tick,
        category: e.category as import("../sim/events/eventLog").EventCategory,
        text: e.text,
      });
    }
  }
  if (save.stockpile) {
    sim.stockpile.ore = save.stockpile.ore;
    sim.stockpile.stone = save.stockpile.stone;
    sim.stockpile.dirt = save.stockpile.dirt;
    if (save.stockpile.food !== undefined) sim.stockpile.food = save.stockpile.food;
    if (save.stockpile.drink !== undefined) sim.stockpile.drink = save.stockpile.drink;
    if (save.stockpile.bars !== undefined) sim.stockpile.bars = save.stockpile.bars;
    if (save.stockpile.tools !== undefined) sim.stockpile.tools = save.stockpile.tools;
    if (save.stockpile.gems !== undefined) sim.stockpile.gems = save.stockpile.gems;
  }
  if (save.oreEverStruck) sim.oreEverStruck = true;
  if (save.lastYearAnnounced !== undefined) sim.lastYearAnnounced = save.lastYearAnnounced;
  if (save.populationMilestones) {
    for (const m of save.populationMilestones) sim.populationMilestones.add(m);
  }
  if (save.sliders) {
    sim.sliders = { ...sim.sliders, ...save.sliders };
  }
  if (save.emergency) {
    sim.emergency = { ...sim.emergency, ...save.emergency };
  }
  if (save.items) {
    for (const it of save.items) {
      sim.spawnItem({ kind: it.kind, x: it.x, y: it.y });
    }
  }
  if (save.research) {
    sim.research.current = save.research.current ?? null;
    sim.research.progress = save.research.progress ?? 0;
    sim.research.completed = [...(save.research.completed ?? [])];
  }
  if (save.hollowKingAware) sim.hollowKingAware = true;
  if (save.hollowKingNightmares !== undefined) sim.hollowKingNightmares = save.hollowKingNightmares;
  if (save.hollowKingLastSiegeTick !== undefined) sim.hollowKingLastSiegeTick = save.hollowKingLastSiegeTick;

  // Restore dwarf HP if it was saved (otherwise spawnDwarf gave them
  // default 100/100 above).
  for (let i = 0; i < save.dwarves.length; i++) {
    const d = save.dwarves[i];
    const e = spawnedEntities[i];
    if (d.health) {
      const hp = sim.health.get(e);
      if (hp) {
        hp.hp = d.health.hp;
        hp.maxHp = d.health.maxHp;
        hp.lastAttackTick = d.health.lastAttackTick;
        hp.wasSevereWound = d.health.wasSevereWound;
      }
    }
  }

  // Restore hostiles.
  if (save.hostiles) {
    for (const h of save.hostiles) {
      sim.spawnHostile({
        kind: h.kind as import("../sim/hostiles/types").HostileKind,
        x: h.x,
        y: h.y,
        hp: h.hp,
        lastAttackTick: h.lastAttackTick,
        lastMoveTick: h.lastMoveTick,
      });
    }
  }

  return sim;
}
