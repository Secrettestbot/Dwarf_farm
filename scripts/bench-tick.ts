/**
 * Hot-loop benchmark + determinism fingerprint.
 *
 * Builds a 60-dwarf colony on a fixed seed, runs N ticks, and prints
 * ms/tick plus an FNV-1a hash of the full save snapshot at a few
 * checkpoints. Run before/after a perf change: ms/tick should drop,
 * the hashes must not change.
 *
 *   npm run bench                    # 60 dwarves, 5000 ticks, seed 4242, 200x500 world
 *   npm run bench -- 60 5000 4242 400 2000   # dwarves ticks seed width height
 */
import { generateWorld } from "../src/sim/world/worldgen";
import { SimWorld } from "../src/sim/world/simWorld";
import { tick } from "../src/sim/sim";
import { snapshot } from "../src/save/snapshot";

const args = process.argv.slice(2).filter((a) => a !== "--");
const DWARVES = Number(args[0] ?? 60);
const TICKS = Number(args[1] ?? 5000);
const SEED = Number(args[2] ?? 4242);
const WIDTH = Number(args[3] ?? 200);
const HEIGHT = Number(args[4] ?? 500);
const CHECKPOINTS = 5;

function fnv(str: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stateHash(sim: SimWorld): string {
  const save = snapshot({
    sim, slotId: "bench", fortressName: "Bench", mode: "legacy",
    cameraX: 0, cameraY: 0, zoomIndex: 1,
  });
  const { realTimestampMs, ...rest } = save;
  void realTimestampMs;
  return fnv(JSON.stringify(rest, (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v)));
}

const w = generateWorld({ seed: SEED, width: WIDTH, height: HEIGHT });
const sim = new SimWorld(SEED, w.grid, w.surfaceY, w.spawn);
for (let i = 0; i < DWARVES; i++) {
  sim.spawnDwarf({ name: `D${i}`, x: w.spawn.x + (i % 9) - 4, y: w.spawn.y, age: 20 + (i % 40) });
}
sim.stockpile.food = 2000;
sim.stockpile.drink = 2000;

const hashes: string[] = [];
let simMs = 0;
const every = Math.max(1, Math.floor(TICKS / CHECKPOINTS));
for (let i = 1; i <= TICKS; i++) {
  const t0 = performance.now();
  tick(sim);
  simMs += performance.now() - t0;
  if (i % every === 0 || i === TICKS) hashes.push(`${i}:${stateHash(sim)}`);
}

console.log(`dwarves=${DWARVES} (alive at end: ${sim.dwarf.size()}) ticks=${TICKS} seed=${SEED} world=${WIDTH}x${HEIGHT}`);
console.log(`items at end: ${sim.item.size()}`);
console.log(`total sim ms: ${simMs.toFixed(0)}  ms/tick: ${(simMs / TICKS).toFixed(3)}`);
console.log(`hashes: ${hashes.join(" ")}`);
