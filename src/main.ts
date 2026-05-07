import { generateWorld } from "./sim/world/worldgen";
import { SimWorld } from "./sim/world/simWorld";
import { tick } from "./sim/sim";
import { Clock, SpeedLevel, TICKS_PER_SECOND_AT_1X, TICKS_PER_DAY } from "./sim/time";
import { Camera } from "./render/camera";
import { renderWorld } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { Hud } from "./ui/hud";
import { showTitleScreen } from "./ui/titleScreen";
import { showReturnScreen } from "./ui/returnScreen";
import { restore, snapshot } from "./save/snapshot";
import { saveGame } from "./save/db";
import { SaveV1 } from "./save/schema";
import { WorkerToMain } from "./shared/protocol";

const WORLD_WIDTH = 200;
const WORLD_HEIGHT = 500;
const SLOT = "slot0";
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

boot().catch((err) => {
  console.error(err);
  uiHost.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;color:#f88;font-family:monospace;">${
    err instanceof Error ? err.message : String(err)
  }</div>`;
});

async function boot() {
  const choice = await showTitleScreen(uiHost);

  let sim: SimWorld;
  let camera = new Camera();
  if (choice.kind === "new") {
    const seed = choice.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const w = generateWorld({ seed, width: WORLD_WIDTH, height: WORLD_HEIGHT });
    sim = new SimWorld(seed, w.grid, w.surfaceY, w.spawn);
    sim.spawnDwarf("Borin Stoneback", w.spawn.x, w.spawn.y);
    camera.x = w.spawn.x;
    camera.y = w.spawn.y;
    camera.setZoom(2);
    // Initial save so Continue works immediately.
    await persist(sim, camera);
  } else {
    const save = choice.existingSave!;
    const elapsedMs = Date.now() - save.realTimestampMs;
    const tickRate = TICKS_PER_SECOND_AT_1X; // catch-up runs at 1× equivalent
    let ticksToRun = Math.max(0, Math.floor((elapsedMs / 1000) * tickRate));
    if (ticksToRun > MAX_CATCHUP_TICKS) ticksToRun = MAX_CATCHUP_TICKS;

    if (ticksToRun > 0) {
      sim = await catchUp(save, elapsedMs, ticksToRun);
    } else {
      sim = restore(save);
    }
    camera.x = save.cameraX;
    camera.y = save.cameraY;
    camera.setZoom(save.zoomIndex);
  }

  runGame(sim, camera);
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
        // Brief beat so the bar reaches 100% visibly.
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

function runGame(sim: SimWorld, camera: Camera) {
  const clock = new Clock();
  clock.tick = sim.tick;
  clock.setSpeed(1);

  const minimap = new Minimap(sim.grid.width, sim.grid.height);
  minimap.refresh(sim, performance.now(), true);

  let paintMode = false;
  let painting: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let panStart: { mx: number; my: number; cx: number; cy: number } | null = null;
  let isPanning = false;

  const hud = new Hud(uiHost, {
    onSpeedChange(s: SpeedLevel) {
      clock.setSpeed(s);
    },
    async onSave() {
      await persist(sim, camera);
      flashSave();
    },
    onPaintToggle(active) {
      paintMode = active;
      canvas.style.cursor = active ? "crosshair" : "default";
    },
    onClearZones() {
      sim.digZones.clear();
    },
  });

  // ---- Input ----
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const tile = camera.screenToTile(e.clientX, e.clientY, viewW, viewH);
    if (paintMode) {
      const rx = Math.floor(tile.x);
      const ry = Math.floor(tile.y);
      painting = { x0: rx, y0: ry, x1: rx, y1: ry };
    } else {
      panStart = { mx: e.clientX, my: e.clientY, cx: camera.x, cy: camera.y };
      isPanning = false;
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (painting) {
      const tile = camera.screenToTile(e.clientX, e.clientY, viewW, viewH);
      painting.x1 = Math.floor(tile.x);
      painting.y1 = Math.floor(tile.y);
    } else if (panStart) {
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
    if (painting) {
      // Only commit zones that actually cover at least one tile.
      sim.digZones.add(painting);
      painting = null;
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
      void persist(sim, camera);
    }
  });
  window.addEventListener("beforeunload", () => {
    void persist(sim, camera);
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
      void persist(sim, camera);
    }

    minimap.refresh(sim, now);

    renderWorld(ctx, sim, camera, viewW, viewH, { digZonePreview: painting });

    // Minimap in bottom-right.
    const mx = viewW - minimap.width - 14;
    const my = viewH - minimap.height - 14;
    minimap.draw(ctx, mx, my, camera, viewW, viewH);

    hud.update(clock, sim.dwarf.size());
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

let saveInFlight: Promise<void> | null = null;
async function persist(sim: SimWorld, camera: Camera): Promise<void> {
  if (saveInFlight) return saveInFlight;
  const save = snapshot({
    sim,
    slotId: SLOT,
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
