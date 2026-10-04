// Embark: put a new fortress's founders and starter kit into the world.
// Shared by the game (src/main.ts) and by tests that need a realistic
// day-one colony.

import { SimWorld } from "../world/simWorld";
import { Founder } from "./founders";

/**
 * Place the founders into the starter cavern and lay out the starter
 * kit. We line them up across the carved chamber. Their entity ids and order in the dwarf store determine
 * iteration order in the deterministic tick, so the placement loop runs in
 * the same order on every machine.
 */
export function placeFounders(sim: SimWorld, founders: Founder[]) {
  const { spawn, grid } = sim;
  // Find the row of walkable tiles around the spawn that constitutes the
  // founders' chamber. We just spread them along y = spawn.y.
  const placements: Array<{ x: number; y: number }> = [];
  for (let dx = -6; dx <= 6 && placements.length < founders.length; dx++) {
    const x = spawn.x + dx;
    if (grid.isWalkable(x, spawn.y)) placements.push({ x, y: spawn.y });
  }
  // Fallback if we couldn't fit them all on one row.
  for (let dy = 1; placements.length < founders.length && dy < 4; dy++) {
    for (let dx = -6; dx <= 6 && placements.length < founders.length; dx++) {
      const x = spawn.x + dx;
      const y = spawn.y + dy;
      if (grid.isWalkable(x, y)) placements.push({ x, y });
    }
  }

  for (let i = 0; i < founders.length; i++) {
    const f = founders[i];
    const p = placements[i] ?? { x: spawn.x, y: spawn.y };
    sim.spawnDwarf({
      name: f.name,
      x: p.x,
      y: p.y,
      traitIds: f.traits.map((t) => t.id),
      skills: f.skills,
      profession: f.profession,
      age: f.age,
    });
  }
  // Starter equipment — the founders arrive with one bed each
  // (placed as items at spawn so the first bedrooms can be
  // furnished without first standing up a carpenter) and a couple
  // of brewing barrels (one for the first brewery, one for an
  // expansion later). Plus a small planks + wood reserve so the
  // carpenter can keep crafting furniture for migrants without
  // running dry on day one.
  const starterBeds = founders.length;
  for (let i = 0; i < starterBeds; i++) {
    sim.spawnItem({ kind: "bed", x: spawn.x, y: spawn.y });
  }
  for (let i = 0; i < 2; i++) {
    sim.spawnItem({ kind: "barrel", x: spawn.x, y: spawn.y });
  }
  // One pre-built table for the first dining hall; one pre-built
  // bin so the first stockpile is operational on day one too;
  // one pre-built stove for the first kitchen. The founders bring
  // a small starter kit of finished pieces; the rest the colony
  // has to craft as it grows.
  sim.spawnItem({ kind: "table", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "bin", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "stove", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "library_desk", x: spawn.x, y: spawn.y });
  // Hospital cot + tavern counter pre-built so those rooms can stand
  // up without waiting on a carpenter. Throne is NOT pre-built — the
  // colony has to earn its crown via mason work later in the game.
  sim.spawnItem({ kind: "hospital_bed", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "tavern_counter", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "armoury_rack", x: spawn.x, y: spawn.y });
  // No pre-built pump_part — pumps are an emergency response to an
  // aquifer breach, and the carpenter prioritises them ahead of
  // everything else when one's needed. The colony has to actually
  // build the part when the time comes.
  // Slice 8 starter kit — one of each workshop bench / anvil /
  // firebox so the first carpenter / mason / smelter / etc. can
  // stand up the moment their cavity finishes digging. Without
  // these the chain dead-locks: a mason_bench can only be made by
  // a carpenter, a carpenter_bench can only be made by a mason,
  // and the first colony has neither. One trade-scales for the
  // first depot, one water-wheel axle for the first wheel, and
  // one seed bag so the first farm goes productive on day one.
  sim.spawnItem({ kind: "carpenter_bench", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "mason_bench", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "smelter_furnace", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "forge_anvil", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "magma_anvil", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "jeweller_bench", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "kiln_firebox", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "tannery_vat", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "loom_frame", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "trade_scales", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "water_wheel_axle", x: spawn.x, y: spawn.y });
  sim.spawnItem({ kind: "seed_bag", x: spawn.x, y: spawn.y });
  sim.stockpile.planks += 8;
  sim.stockpile.wood += 4;
  // A small block cache so the mason can carve a table for a
  // dining hall expansion before mining catches up.
  sim.stockpile.blocks += 4;
  // Reveal the founders' immediate surroundings before the first frame so
  // the New Game screen doesn't open onto an all-black mountain.
  sim.revealAroundDwarves();
}
