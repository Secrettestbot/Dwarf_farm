// Pet spawning, taming, and behaviour — extracted verbatim from
// sim.ts as part of the systems/ decomposition. See petSpawnSystem /
// petSystem for the per-tick entry points; PET_DEFS is shared with
// visibilitySystem (cave-bat vision bonus).

import { SimWorld } from "../world/simWorld";
import { TICKS_PER_YEAR } from "../time";
import { HOSTILE_DEFS, HostileKind } from "../hostiles/types";
import { awardSkillXp } from "./shared";

// ---- Pets and domestication ----------------------------------------
//
// Once per in-game year a wild cave dog roams onto the colony's
// surface clearing. Without intervention it just wanders peacefully;
// any dwarf with farming skill ≥ PET_TAME_MIN_SKILL who stands
// adjacent accumulates tameProgress on the pet. Once it crosses the
// threshold the pet flips from wild to tame, the dwarf becomes its
// owner, and the chronicle records the bond.
//
// Tame pets follow their owner around within a small radius and
// attack adjacent low-tier hostiles (cave rats, bats, spiders) —
// the colony's first line of pest control. Pets can be killed in
// combat; if their owner dies, they go feral (stay tame but no
// owner is named — they wander the colony and still hunt pests).

const PET_SPAWN_INTERVAL = TICKS_PER_YEAR;
/** Probability of a wild pet appearing on each yearly tick. The
 * "rare" knob — turn this down for fewer pets across a fortress's
 * lifetime. 0.6 means most years see one show up. */
const PET_SPAWN_CHANCE = 0.6;
const PET_TAME_MIN_SKILL = 5; // Adequate Farming
const PET_TAME_THRESHOLD = 90; // ~1.5 in-game hours of contact
const PET_TAME_PROGRESS_PER_TICK = 1;
/** A tame pet stays within this radius of its owner. */
const PET_FOLLOW_RADIUS = 6;
/** Hostile kinds a tame pet will engage. Cave dogs aren't going
 * to take on a troll — pest tier only. */
const PET_TARGET_KINDS: ReadonlyArray<HostileKind> = ["cave_rat", "cave_bat", "cave_spider"];

interface PetDef {
  kind: import("../ecs/components").PetKind;
  /** Display label for chronicle lines. */
  label: string;
  /** Article for "a/an X" — keeps narration grammatical without
   * a vowel-detection loop. */
  spawnArticle: string;
  /** Spawn weight — falcons are rarer than dogs, bats sit between. */
  spawnWeight: number;
  attackDamage: number;
  attackCooldown: number;
  /** Tile radius the pet checks for adjacent pests. Falcons get
   * a 2-tile range (a quick stoop) instead of dogs' 1-tile. */
  attackRadius: number;
  /** Visibility bonus the pet grants its owner — extra reveal-tiles
   * around the dwarf each tick. The cave bat's echolocation. */
  visionRadius: number;
  /** Max HP. Falcons are fragile; bats fragiler still. */
  maxHp: number;
}

export const PET_DEFS: Record<import("../ecs/components").PetKind, PetDef> = {
  cave_dog: {
    kind: "cave_dog",
    label: "cave dog",
    spawnArticle: "a cave dog",
    spawnWeight: 60,
    attackDamage: 8,
    attackCooldown: 60,
    attackRadius: 1,
    visionRadius: 0,
    maxHp: 35,
  },
  cave_bat: {
    kind: "cave_bat",
    label: "cave bat",
    spawnArticle: "a cave bat",
    spawnWeight: 25,
    // The bat doesn't fight directly — its passive vision bonus is
    // its job. Tiny attack stats just so a cornered bat does
    // something rather than nothing.
    attackDamage: 2,
    attackCooldown: 120,
    attackRadius: 1,
    visionRadius: 4,
    maxHp: 12,
  },
  cave_falcon: {
    kind: "cave_falcon",
    label: "cave falcon",
    spawnArticle: "a cave falcon",
    spawnWeight: 15,
    attackDamage: 6,
    attackCooldown: 45,
    // Stoop range — a falcon swoops from a few tiles out.
    attackRadius: 2,
    visionRadius: 0,
    maxHp: 18,
  },
};

export function pickPetKind(rng: import("../rng").Rng): import("../ecs/components").PetKind {
  const totalWeight = PET_DEFS.cave_dog.spawnWeight + PET_DEFS.cave_bat.spawnWeight + PET_DEFS.cave_falcon.spawnWeight;
  const r = rng.nextFloat() * totalWeight;
  let acc = 0;
  for (const def of [PET_DEFS.cave_dog, PET_DEFS.cave_bat, PET_DEFS.cave_falcon]) {
    acc += def.spawnWeight;
    if (r < acc) return def.kind;
  }
  return "cave_dog";
}

export function petSpawnSystem(sim: SimWorld): void {
  if (sim.tick === 0) return;
  if (sim.tick % PET_SPAWN_INTERVAL !== 0) return;
  if (sim.aiRng.nextFloat() >= PET_SPAWN_CHANCE) return;
  // Spawn near the surface clearing — the entrance shaft top is the
  // simplest reliable walkable surface tile. Wander a few tiles
  // laterally so successive years don't all drop pets on the same
  // square.
  const centreX = sim.spawn.x + sim.aiRng.nextRange(-6, 7);
  const centreY = Math.max(0, sim.spawn.y - 8);
  // Find the first walkable tile at or below this column.
  let sx = centreX;
  let sy = centreY;
  for (let probe = 0; probe < 12; probe++) {
    if (sim.grid.isWalkable(sx, sy)) break;
    sy++;
  }
  if (!sim.grid.isWalkable(sx, sy)) return;
  const kind = pickPetKind(sim.aiRng);
  const def = PET_DEFS[kind];
  sim.spawnPet({ kind, x: sx, y: sy, maxHp: def.maxHp });
  sim.events.add(
    sim.tick,
    "discovery",
    `${def.spawnArticle.charAt(0).toUpperCase() + def.spawnArticle.slice(1)} has wandered up to the entrance. It eyes the gate without hostility.`,
  );
}

/** Per-tick pet behaviour: wild pets accumulate tame progress
 * adjacent to a skilled dwarf; tame pets follow their owner and
 * attack adjacent pests. Combat damage is uniform; the pet is
 * itself targetable in combat (the existing combatSystem treats it
 * as a non-hostile and skips it, so we let pests bite them only
 * when they bite first). */
export function petSystem(sim: SimWorld): void {
  const ents = sim.pet.entities.slice();
  for (const id of ents) {
    const pet = sim.pet.get(id);
    const pos = sim.position.get(id);
    const hp = sim.health.get(id);
    if (!pet || !pos || !hp) continue;
    const def = PET_DEFS[pet.kind];
    if (hp.hp <= 0) {
      // Dead pet: chronicle line, then despawn.
      sim.events.add(
        sim.tick,
        "crisis",
        pet.tamedAtTick > 0
          ? `The colony's ${def.label} has been killed in the tunnels.`
          : `The wild ${def.label} dies of its wounds.`,
      );
      sim.destroyPet(id);
      continue;
    }
    if (pet.tamedAtTick < 0) {
      // Wild: see if any farmer is adjacent to tame us.
      let tamer = -1;
      sim.forEachDwarf((dwId, dpos, dw) => {
        if (tamer !== -1) return;
        if ((dw.skills.farming ?? 1) < PET_TAME_MIN_SKILL) return;
        const dx = Math.abs(dpos.x - pos.x);
        const dy = Math.abs(dpos.y - pos.y);
        if (dx <= 1 && dy <= 1) tamer = dwId;
      });
      if (tamer !== -1) {
        pet.tameProgress += PET_TAME_PROGRESS_PER_TICK;
        if (pet.tameProgress >= PET_TAME_THRESHOLD) {
          const tamerDw = sim.dwarf.get(tamer);
          pet.tamedAtTick = sim.tick;
          pet.ownerId = tamer;
          pet.ownerName = tamerDw?.name;
          if (tamerDw) {
            // Award farming XP for the successful tame — the work
            // counts toward the skill.
            awardSkillXp(sim, tamer, "farming", 5);
            sim.events.add(
              sim.tick,
              "social",
              `${tamerDw.name} tames the ${def.label}. It will follow them now.`,
            );
          }
        }
      }
      // Wild pets just stand still — no movement system for them.
      continue;
    }
    // Tame: combat first (pests within range), then follow.
    if (sim.tick - pet.lastAttackTick >= def.attackCooldown) {
      const target = findPetTarget(sim, pos.x, pos.y, def.attackRadius);
      if (target !== -1) {
        const tHp = sim.health.get(target);
        if (tHp) {
          tHp.hp -= def.attackDamage;
          pet.lastAttackTick = sim.tick;
          if (tHp.hp <= 0) {
            const hostile = sim.hostile.get(target);
            const hDef = hostile ? HOSTILE_DEFS[hostile.kind] : null;
            const ownerName = pet.ownerName ?? `the ${def.label}`;
            if (hDef) {
              sim.events.add(
                sim.tick,
                "discovery",
                `${ownerName}'s ${def.label} brings down a ${hDef.name}.`,
              );
            }
            sim.ecs.destroy(target, [sim.position, sim.hostile, sim.health]);
          }
          continue;
        }
      }
    }
    // Vision bonus — cave bats reveal a small radius around the
    // owner's tile every tick. The vision radius is added to the
    // owner's normal sight via the existing fog-of-war reveal hooks
    // — visibilitySystem reads pet.kind to apply the bump.
    // (Implemented in visibilitySystem itself for proximity to the
    // existing radius logic.)
    void def.visionRadius;
    // Follow the owner — if they're alive, drift one tile toward
    // them whenever we exceed the follow radius. Cheap step rather
    // than full A*.
    let owner = pet.ownerId;
    if (owner !== -1 && !sim.ecs.isAlive(owner)) {
      // Owner died: pet stays tame but loses its named owner. They
      // continue to hunt pests around the colony.
      pet.ownerId = -1;
      sim.events.add(
        sim.tick,
        "social",
        `${pet.ownerName ?? "Someone"}'s ${def.label} wanders the halls alone now.`,
      );
      owner = -1;
    }
    if (owner !== -1) {
      const opos = sim.position.get(owner);
      if (opos) {
        const dx = opos.x - pos.x;
        const dy = opos.y - pos.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > PET_FOLLOW_RADIUS * PET_FOLLOW_RADIUS && sim.tick % 4 === 0) {
          const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
          const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
          const nx = pos.x + stepX;
          const ny = pos.y + stepY;
          if (sim.grid.isWalkable(nx, ny)) {
            pos.x = nx;
            pos.y = ny;
          }
        }
      }
    }
  }
}

function findPetTarget(sim: SimWorld, sx: number, sy: number, radius: number): number {
  const ents = sim.hostile.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const h = sim.hostile.get(id);
    const p = sim.position.get(id);
    if (!h || !p) continue;
    if (!PET_TARGET_KINDS.includes(h.kind)) continue;
    const dx = Math.abs(p.x - sx);
    const dy = Math.abs(p.y - sy);
    if (dx <= radius && dy <= radius) return id;
  }
  return -1;
}

