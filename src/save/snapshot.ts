import { SimWorld } from "../sim/world/simWorld";
import { generateWorld } from "../sim/world/worldgen";
import { CURRENT_SAVE_VERSION, SaveV1, SavedBlueprint, SavedDwarf, SavedHostile, SavedPet, GameMode } from "./schema";
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
    const obsession = sim.obsession.get(id);
    const tantrum = sim.tantrum.get(id);
    dwarves.push({
      name: dw.name,
      x: pos.x,
      y: pos.y,
      traitIds: dw.traitIds,
      skills: dw.skills,
      skillXp: dw.skillXp as Record<string, number>,
      profession: dw.profession,
      bornAtTick: dw.bornAtTick,
      bornInColony: dw.bornInColony,
      partnerIndex,
      lastJobTick: dw.lastJobTick,
      lostPartnerGrave: dw.lostPartnerGrave ? { ...dw.lostPartnerGrave } : undefined,
      lastGraveVisitTick: dw.lastGraveVisitTick,
      parentNames: dw.parentNames ? [dw.parentNames[0], dw.parentNames[1]] : undefined,
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
      carrying: carrying ? { kind: carrying.kind, quality: carrying.quality } : undefined,
      squad: squad ? { draftedAtTick: squad.draftedAtTick } : undefined,
      equipment: equipment ? { weapon: equipment.weapon, weaponQuality: equipment.weaponQuality } : undefined,
      obsession: obsession ? { skillId: obsession.skillId, endsAtTick: obsession.endsAtTick } : undefined,
      tantrum: tantrum ? { startedAtTick: tantrum.startedAtTick, endsAtTick: tantrum.endsAtTick } : undefined,
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
      quality: b.quality,
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
      meals: sim.stockpile.meals,
      blocks: sim.stockpile.blocks,
      cut_gems: sim.stockpile.cut_gems,
      wood: sim.stockpile.wood,
      planks: sim.stockpile.planks,
      pots: sim.stockpile.pots,
      hide: sim.stockpile.hide,
      leather: sim.stockpile.leather,
      rope: sim.stockpile.rope,
      cloth: sim.stockpile.cloth,
    },
    oreEverStruck: sim.oreEverStruck,
    lastYearAnnounced: sim.lastYearAnnounced,
    populationMilestones: Array.from(sim.populationMilestones),
    narrativeMilestones: Array.from(sim.narrativeMilestones),
    hostiles: collectHostiles(sim),
    pets: collectPets(sim, entityToIndex),
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
    hollowKingSpawned: sim.hollowKingSpawned,
    voidShadesSlain: sim.voidShadesSlain,
    aquiferBreachTick: sim.aquiferBreachTick,
    caravan: sim.caravanLeavesTick > 0
      ? { x: sim.caravanX, y: sim.caravanY, leavesTick: sim.caravanLeavesTick, origin: sim.caravanOrigin }
      : undefined,
    graves: sim.graves.length > 0 ? sim.graves.map((g) => ({ ...g })) : undefined,
    artifacts: sim.artifacts.length > 0 ? sim.artifacts.map((a) => ({ ...a })) : undefined,
    artifactsNextId: sim.artifactsNextId,
    books: sim.books.length > 0 ? sim.books.map((b) => ({ ...b })) : undefined,
    mayorName: sim.mayorName || undefined,
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
    out.push({ kind: it.kind, x: p.x, y: p.y, quality: it.quality });
  }
  return out;
}

function collectPets(sim: SimWorld, entityToIndex: Map<number, number>): SavedPet[] {
  const out: SavedPet[] = [];
  const ents = sim.pet.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const pet = sim.pet.get(e);
    const p = sim.position.get(e);
    const hp = sim.health.get(e);
    if (!pet || !p || !hp) continue;
    const ownerIndex = pet.ownerId !== -1 ? (entityToIndex.get(pet.ownerId) ?? -1) : -1;
    out.push({
      kind: pet.kind,
      x: p.x,
      y: p.y,
      hp: hp.hp,
      maxHp: hp.maxHp,
      ownerIndex,
      ownerName: pet.ownerName,
      tameProgress: pet.tameProgress,
      tamedAtTick: pet.tamedAtTick,
      lastAttackTick: pet.lastAttackTick,
    });
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
      bornInColony: d.bornInColony ?? false,
      parentNames: d.parentNames ? [d.parentNames[0], d.parentNames[1]] : undefined,
    });
    const restoredDw = sim.dwarf.get(e)!;
    restoredDw.lastJobTick = d.lastJobTick ?? 0;
    if (d.lostPartnerGrave) restoredDw.lostPartnerGrave = { ...d.lostPartnerGrave };
    if (d.lastGraveVisitTick !== undefined) restoredDw.lastGraveVisitTick = d.lastGraveVisitTick;
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
      sim.carrying.set(e, { kind: d.carrying.kind, quality: d.carrying.quality });
    }
    if (d.squad) {
      sim.squad.set(e, { draftedAtTick: d.squad.draftedAtTick });
    }
    if (d.equipment) {
      sim.equipment.set(e, { weapon: d.equipment.weapon, weaponQuality: d.equipment.weaponQuality });
    }
    if (d.obsession) {
      sim.obsession.set(e, { skillId: d.obsession.skillId, endsAtTick: d.obsession.endsAtTick });
    }
    if (d.tantrum) {
      sim.tantrum.set(e, { startedAtTick: d.tantrum.startedAtTick, endsAtTick: d.tantrum.endsAtTick });
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
      quality: b.quality,
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
    if (save.stockpile.meals !== undefined) sim.stockpile.meals = save.stockpile.meals;
    if (save.stockpile.blocks !== undefined) sim.stockpile.blocks = save.stockpile.blocks;
    if (save.stockpile.cut_gems !== undefined) sim.stockpile.cut_gems = save.stockpile.cut_gems;
    if (save.stockpile.wood !== undefined) sim.stockpile.wood = save.stockpile.wood;
    if (save.stockpile.planks !== undefined) sim.stockpile.planks = save.stockpile.planks;
    if (save.stockpile.pots !== undefined) sim.stockpile.pots = save.stockpile.pots;
    if (save.stockpile.hide !== undefined) sim.stockpile.hide = save.stockpile.hide;
    if (save.stockpile.leather !== undefined) sim.stockpile.leather = save.stockpile.leather;
    if (save.stockpile.rope !== undefined) sim.stockpile.rope = save.stockpile.rope;
    if (save.stockpile.cloth !== undefined) sim.stockpile.cloth = save.stockpile.cloth;
  }
  if (save.oreEverStruck) sim.oreEverStruck = true;
  if (save.lastYearAnnounced !== undefined) sim.lastYearAnnounced = save.lastYearAnnounced;
  if (save.populationMilestones) {
    for (const m of save.populationMilestones) sim.populationMilestones.add(m);
  }
  if (save.narrativeMilestones) {
    for (const m of save.narrativeMilestones) sim.narrativeMilestones.add(m);
  }
  if (save.sliders) {
    sim.sliders = { ...sim.sliders, ...save.sliders };
  }
  if (save.emergency) {
    sim.emergency = { ...sim.emergency, ...save.emergency };
  }
  if (save.items) {
    for (const it of save.items) {
      sim.spawnItem({ kind: it.kind, x: it.x, y: it.y, quality: it.quality });
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
  if (save.hollowKingSpawned) sim.hollowKingSpawned = true;
  if (save.voidShadesSlain !== undefined) sim.voidShadesSlain = save.voidShadesSlain;
  if (save.aquiferBreachTick !== undefined) sim.aquiferBreachTick = save.aquiferBreachTick;
  if (save.caravan) {
    sim.caravanX = save.caravan.x;
    sim.caravanY = save.caravan.y;
    sim.caravanLeavesTick = save.caravan.leavesTick;
    sim.caravanOrigin = save.caravan.origin;
  }
  if (save.graves) {
    for (const g of save.graves) sim.graves.push({ ...g });
  }
  if (save.artifacts) {
    for (const a of save.artifacts) sim.artifacts.push({ ...a });
  }
  if (save.artifactsNextId !== undefined) sim.artifactsNextId = save.artifactsNextId;
  if (save.books) {
    for (const b of save.books) sim.books.push({ ...b });
  }
  if (save.mayorName) sim.mayorName = save.mayorName;

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
  // Restore pets — wild and tame both. ownerIndex maps back through
  // the dwarf-restoration array so the owner's entity id is correct
  // even though the save format doesn't carry raw ids.
  if (save.pets) {
    for (const p of save.pets) {
      const ownerId = p.ownerIndex >= 0 ? spawnedEntities[p.ownerIndex] ?? -1 : -1;
      sim.spawnPet({
        kind: p.kind as import("../sim/ecs/components").PetKind,
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        ownerId,
        ownerName: p.ownerName,
        tameProgress: p.tameProgress,
        tamedAtTick: p.tamedAtTick,
      });
    }
  }

  return sim;
}
