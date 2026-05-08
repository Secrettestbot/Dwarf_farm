import { generateWorld } from "./sim/world/worldgen";
import { SimWorld } from "./sim/world/simWorld";
import { tick } from "./sim/sim";
import { Clock, SpeedLevel, TICKS_PER_SECOND_AT_1X, TICKS_PER_DAY } from "./sim/time";
import { Camera } from "./render/camera";
import { renderWorld } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { Hud } from "./ui/hud";
import { EventLogPanel } from "./ui/eventLogPanel";
import { DwarfInspector } from "./ui/dwarfInspector";
import { showTitleScreen } from "./ui/titleScreen";
import { showFoundersScreen } from "./ui/foundersScreen";
import { showReturnScreen } from "./ui/returnScreen";
import { restore, snapshot } from "./save/snapshot";
import { saveGame, loadGame } from "./save/db";
import { GameMode, SaveSlotId, SaveV1 } from "./save/schema";
import { WorkerToMain } from "./shared/protocol";
import { Founder } from "./sim/dwarves/founders";
import { narrateFounding } from "./sim/events/narrator";

const WORLD_WIDTH = 200;
const WORLD_HEIGHT = 500;
// 1 in-game month at the GDD's 1× rate is the catch-up cap.
const MAX_CATCHUP_TICKS = TICKS_PER_DAY * 30;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
const uiHost = document.getElementById("ui") as HTMLDivElement;

let viewW = 0;
let viewH = 0;
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.floor(viewW * dpr);
  canvas.height = Math.floor(viewH * dpr);
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
resize();
window.addEventListener("resize", resize);

interface ActiveFortress {
  sim: SimWorld;
  slotId: SaveSlotId;
  fortressName: string;
  mode: GameMode;
}

boot().catch((err) => {
  console.error(err);
  uiHost.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;color:#f88;font-family:monospace;">${
    err instanceof Error ? err.message : String(err)
  }</div>`;
});

async function boot() {
  const choice = await showTitleScreen(uiHost);

  let active: ActiveFortress;
  let camera = new Camera();

  if (choice.kind === "new") {
    const founderResult = await showFoundersScreen(uiHost, choice.seed);
    const w = generateWorld({ seed: choice.seed, width: WORLD_WIDTH, height: WORLD_HEIGHT });
    const sim = new SimWorld(choice.seed, w.grid, w.surfaceY, w.spawn);
    placeFounders(sim, founderResult.founders);
    sim.events.add(0, "founding", narrateFounding(founderResult.founders.map((f) => f.name)));
    camera.x = w.spawn.x;
    camera.y = w.spawn.y;
    camera.setZoom(2);
    active = { sim, slotId: choice.slotId, fortressName: founderResult.fortressName, mode: choice.mode };
    await persist(active, camera);
  } else {
    const save = await loadGame(choice.slotId);
    if (!save) throw new Error(`No save in ${choice.slotId}`);
    const elapsedMs = Date.now() - save.realTimestampMs;
    const tickRate = TICKS_PER_SECOND_AT_1X;
    let ticksToRun = Math.max(0, Math.floor((elapsedMs / 1000) * tickRate));
    if (ticksToRun > MAX_CATCHUP_TICKS) ticksToRun = MAX_CATCHUP_TICKS;

    const sim = ticksToRun > 0 ? await catchUp(save, elapsedMs, ticksToRun) : restore(save);
    camera.x = save.cameraX;
    camera.y = save.cameraY;
    camera.setZoom(save.zoomIndex);
    active = { sim, slotId: save.slotId as SaveSlotId, fortressName: save.fortressName, mode: save.mode };
  }

  runGame(active, camera);
}

/**
 * Place the founding seven into the starter cavern. We line them up across the
 * carved chamber. Their entity ids and order in the dwarf store determine
 * iteration order in the deterministic tick, so the placement loop runs in
 * the same order on every machine.
 */
function placeFounders(sim: SimWorld, founders: Founder[]) {
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
  // Reveal the founders' immediate surroundings before the first frame so
  // the New Game screen doesn't open onto an all-black mountain.
  sim.revealAroundDwarves();
}

async function catchUp(save: SaveV1, elapsedMs: number, ticksToRun: number): Promise<SimWorld> {
  const screen = showReturnScreen(uiHost, elapsedMs, ticksToRun);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/sim.worker.ts", import.meta.url), { type: "module" });
    worker.onerror = (e) => {
      screen.close();
      worker.terminate();
      reject(new Error(`Worker error: ${e.message}`));
    };
    worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
      const msg = ev.data;
      if (msg.type === "READY") {
        screen.setStatus("Simulating elapsed time…");
      } else if (msg.type === "PROGRESS") {
        screen.setProgress(msg.ticksDone, msg.ticksDone + msg.ticksRemaining);
      } else if (msg.type === "DONE") {
        screen.setProgress(ticksToRun, ticksToRun);
        screen.setStatus("Done. Resuming.");
        worker.terminate();
        setTimeout(() => {
          screen.close();
          const sim = restore(msg.save);
          resolve(sim);
        }, 200);
      } else if (msg.type === "ERROR") {
        screen.close();
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.postMessage({ type: "INIT", save, ticksToRun });
  });
}

function runGame(active: ActiveFortress, camera: Camera) {
  const { sim } = active;
  const clock = new Clock();
  clock.tick = sim.tick;
  clock.setSpeed(1);

  const minimap = new Minimap(sim.grid.width, sim.grid.height);
  minimap.refresh(sim, performance.now(), true);

  let panStart: { mx: number; my: number; cx: number; cy: number } | null = null;
  let isPanning = false;

  const hud = new Hud(uiHost, {
    fortressName: active.fortressName,
    mode: active.mode,
    onSpeedChange(s: SpeedLevel) { clock.setSpeed(s); },
    async onSave() {
      await persist(active, camera);
      flashSave();
    },
  });
  const eventPanel = new EventLogPanel(uiHost);
  const inspector = new DwarfInspector(uiHost);

  // ---- Input: pan + zoom only. The dwarves act on their own. ----
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    panStart = { mx: e.clientX, my: e.clientY, cx: camera.x, cy: camera.y };
    isPanning = false;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (panStart) {
      const dx = e.clientX - panStart.mx;
      const dy = e.clientY - panStart.my;
      if (!isPanning && Math.hypot(dx, dy) > 3) isPanning = true;
      if (isPanning) {
        camera.x = panStart.cx - dx / camera.pxPerTile;
        camera.y = panStart.cy - dy / camera.pxPerTile;
      }
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    canvas.releasePointerCapture(e.pointerId);
    // A pointer up that wasn't preceded by a real drag is treated as a
    // click — see if it landed on a dwarf and open the inspector.
    if (panStart && !isPanning) {
      const tile = camera.screenToTile(e.clientX, e.clientY, viewW, viewH);
      const tx = Math.floor(tile.x);
      const ty = Math.floor(tile.y);
      const id = findDwarfNear(active.sim, tx, ty);
      if (id !== null) {
        inspector.open(id);
      } else {
        // Click on empty space closes the inspector.
        inspector.close();
      }
    }
    panStart = null;
    isPanning = false;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const tile = camera.screenToTile(e.clientX, e.clientY, viewW, viewH);
    camera.zoomBy(e.deltaY < 0 ? +1 : -1, tile.x, tile.y);
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      clock.setSpeed(clock.speed === 0 ? 1 : 0);
    } else if (e.key === "1") clock.setSpeed(1);
    else if (e.key === "2") clock.setSpeed(4);
    else if (e.key === "3") clock.setSpeed(16);
  });

  // ---- Auto-save lifecycle ----
  let autoSaveAccum = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void persist(active, camera);
    }
  });
  window.addEventListener("beforeunload", () => {
    void persist(active, camera);
  });

  // ---- Game loop ----
  let lastFrame = performance.now();
  function frame(now: number) {
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;

    const ticks = clock.consume(dt);
    for (let i = 0; i < ticks; i++) tick(sim);

    autoSaveAccum += ticks;
    if (autoSaveAccum >= 60) {
      autoSaveAccum = 0;
      void persist(active, camera);
    }

    minimap.refresh(sim, now);

    renderWorld(ctx, sim, camera, viewW, viewH);

    const mx = viewW - minimap.width - 14;
    const my = viewH - minimap.height - 14;
    minimap.draw(ctx, mx, my, camera, viewW, viewH);

    hud.update(clock, sim);
    eventPanel.update(sim.events.events);
    inspector.update(sim);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Click tolerance: try the exact tile first, then 1-tile neighbors. */
function findDwarfNear(sim: SimWorld, x: number, y: number): number | null {
  const exact = sim.dwarfAt(x, y);
  if (exact !== null) return exact;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const id = sim.dwarfAt(x + dx, y + dy);
      if (id !== null) return id;
    }
  }
  return null;
}

let saveInFlight: Promise<void> | null = null;
async function persist(active: ActiveFortress, camera: Camera): Promise<void> {
  if (saveInFlight) return saveInFlight;
  const save = snapshot({
    sim: active.sim,
    slotId: active.slotId,
    fortressName: active.fortressName,
    mode: active.mode,
    cameraX: camera.x,
    cameraY: camera.y,
    zoomIndex: camera.zoomIndex,
  });
  saveInFlight = saveGame(save).finally(() => {
    saveInFlight = null;
  });
  return saveInFlight;
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flashSave() {
  let el = document.getElementById("save-flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "save-flash";
    el.className = "panel";
    el.style.cssText =
      "position:absolute;top:8px;right:8px;color:#e0c080;font-size:12px;transition:opacity 200ms;";
    el.textContent = "Saved.";
    uiHost.appendChild(el);
  } else {
    el.style.opacity = "1";
  }
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el!.style.opacity = "0";
  }, 1200);
}
