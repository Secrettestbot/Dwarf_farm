import { generateWorld } from "./sim/world/worldgen";
import { SimWorld } from "./sim/world/simWorld";
import { tick } from "./sim/sim";
import { Clock, SpeedLevel, TICKS_PER_SEASON, TICKS_PER_SECOND_AT_1X } from "./sim/time";
import { Camera } from "./render/camera";
import { renderWorld } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { Hud } from "./ui/hud";
import { SliderPanel } from "./ui/sliders";
import { EmergencyPanel } from "./ui/emergency";
import { EventLogPanel } from "./ui/eventLogPanel";
import { DwarfInspector } from "./ui/dwarfInspector";
import { showTitleScreen } from "./ui/titleScreen";
import { applyStoredSpriteSet } from "./render/spriteSetPref";
import {
  getPauseOnCrisis,
  installHudHotkey,
  isPanelVisible,
  getMinimapDimensions,
  onMinimapDimensionsChange,
} from "./ui/displaySettings";
import { showFoundersScreen } from "./ui/foundersScreen";
import { showReturnScreen, showCatchupChoice } from "./ui/returnScreen";
import { restore, snapshot } from "./save/snapshot";
import { saveGame, loadGame, saveCheckpoint } from "./save/db";
import { GameMode, SaveSlotId, SaveData } from "./save/schema";
import { WorkerToMain } from "./shared/protocol";
import { placeFounders } from "./sim/dwarves/embark";
import { narrateFounding } from "./sim/events/narrator";
import { playEventSound } from "./audio/sound";
import { showTutorial, tutorialAlreadySeen } from "./ui/tutorial";
import { HistoryPanel } from "./ui/historyPanel";
import { ResearchPanel } from "./ui/researchPanel";
import { PopulationPanel } from "./ui/populationPanel";
import { NotificationCenter } from "./ui/notificationCenter";
import { showPrompt } from "./ui/dialog";
import { showFallScreen } from "./ui/fallScreen";
import { HintCenter } from "./ui/hints";

// GDD §5: 400×2000 tiles is the full world scale. Tests use a smaller
// 200×500 world for speed; live play uses the full size.
const WORLD_WIDTH = 400;
const WORLD_HEIGHT = 2000;
// Catch-up cap: three real days. The pre-catch-up choice screen
// (showCatchupChoice) lets the player pick a shorter window if
// they don't want to wait, but Full needs to actually mean "all
// the time you were away" up to a sane ceiling. Three real days
// at 6 ticks/real-second ≈ 1.5M ticks — well bounded and still
// covers weekend gaps without forcing a hard truncation.
const MAX_CATCHUP_TICKS = 3 * 24 * 3600 * TICKS_PER_SECOND_AT_1X;
/** Real-time autosave cadence. Tick-based saving fired every few
 * hundred milliseconds at 16× and hammered IndexedDB; a wall-clock
 * interval keeps the cost flat at any speed. Tab-hide and unload
 * still save immediately. */
const AUTOSAVE_INTERVAL_MS = 30_000;

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
  fallenAtTick?: number;
}

boot().catch((err) => {
  // eslint-disable-next-line no-console -- deliberate: fatal boot error, keep the stack
  console.error(err);
  uiHost.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;color:#f88;font-family:monospace;">${
    err instanceof Error ? err.message : String(err)
  }</div>`;
});

async function boot() {
  // Apply the player's last sprite-set choice (dwarves / mixed /
  // bunnies) before any render fires — the title screen's bunny
  // toggle can change it again before the game starts.
  applyStoredSpriteSet();
  // Global H key toggles the HUD's persistent overlays. Bound once
  // here so it survives save/load swaps of the HUD instance.
  installHudHotkey();
  const choice = await showTitleScreen(uiHost);

  let active: ActiveFortress;
  const camera = new Camera();

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
    // Legacy fortresses get a day-one restore point so a disastrous
    // first season can always be rolled back.
    if (active.mode === "legacy") await checkpoint(active, camera);
    // First-fortress tutorial — shown once across the player's
    // localStorage. The replay button on the HUD opens it again.
    if (!tutorialAlreadySeen()) {
      await showTutorial(uiHost);
    }
  } else {
    const save = await loadGame(choice.slotId);
    if (!save) throw new Error(`No save in ${choice.slotId}`);
    const elapsedMs = Date.now() - save.realTimestampMs;
    const tickRate = TICKS_PER_SECOND_AT_1X;
    let ticksToRun = Math.max(0, Math.floor((elapsedMs / 1000) * tickRate));
    if (ticksToRun > MAX_CATCHUP_TICKS) ticksToRun = MAX_CATCHUP_TICKS;

    // Ask the player how much elapsed time they actually want
    // simulated. Defaults: full, one in-game day, six in-game hours,
    // or skip. Shorter options drop out when they'd be identical to
    // the full elapsed length. A zero-tick return (saved seconds
    // ago) skips the prompt entirely.
    if (ticksToRun > 0) {
      const picked = await showCatchupChoice(uiHost, elapsedMs, ticksToRun);
      ticksToRun = picked.ticks;
    }

    const sim = ticksToRun > 0 ? await catchUp(save, elapsedMs, ticksToRun) : restore(save);
    camera.x = save.cameraX;
    camera.y = save.cameraY;
    camera.setZoom(save.zoomIndex);
    active = {
      sim,
      slotId: save.slotId as SaveSlotId,
      fortressName: save.fortressName,
      mode: save.mode,
      fallenAtTick: save.fallenAtTick,
    };
  }

  runGame(active, camera);
}

async function catchUp(save: SaveData, elapsedMs: number, ticksToRun: number): Promise<SimWorld> {
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
        screen.setStatus("Done. Building digest…");
        worker.terminate();
        // Restore + show the GDD §3.2 digest of what happened. The
        // chronicle entries from the catch-up window land in the
        // restored sim; we filter to just the new ones (tick > the
        // pre-catchup tick from the original save).
        const sim = restore(msg.save);
        const beforeTick = save.tick;
        const digestEvents = sim.events.events.filter((e) => e.tick > beforeTick);
        // The worker stops at its wall-clock budget on very long
        // absences. Say so honestly — the remaining time simply
        // passed quietly rather than being simulated.
        if (msg.ticksDone < msg.ticksRequested) {
          digestEvents.push({
            tick: sim.tick,
            category: "milestone",
            text: `The chronicle replayed ${Math.floor((msg.ticksDone / msg.ticksRequested) * 100)}% of your absence before the scribes tired — the rest of the time passed quietly.`,
          });
        }
        screen.showDigest(digestEvents, () => {
          screen.close();
          resolve(sim);
        });
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
  // Dev-server only: expose live state for console debugging and
  // browser smoke tests. Stripped from production builds.
  if (import.meta.env.DEV) (window as unknown as { __dd: unknown }).__dd = { active, camera };
  const clock = new Clock();
  clock.tick = sim.tick;
  clock.setSpeed(1);

  const initialDims = getMinimapDimensions();
  const minimap = new Minimap(
    sim.grid.width,
    sim.grid.height,
    initialDims.width,
    initialDims.height,
  );
  // Live-update the minimap canvas when the player drags the
  // Display popover sliders.
  onMinimapDimensionsChange((d) => minimap.setDimensions(d.width, d.height));
  minimap.refresh(sim, performance.now(), true);

  const historyPanel = new HistoryPanel(uiHost);
  const researchPanel = new ResearchPanel(uiHost);
  const notifications = new NotificationCenter(uiHost, camera);
  // Population panel needs the inspector to wire row-click → inspect.
  // Inspector is constructed below; declare here so HUD click handlers
  // can close over the variable (closures resolve at click time).
  let populationPanel: PopulationPanel | null = null;

  let panStart: { mx: number; my: number; cx: number; cy: number } | null = null;
  let isPanning = false;
  // Last non-zero speed, so unpausing returns to where the player was
  // (space at 16x shouldn't drop the game back to 1x).
  let lastRunSpeed: SpeedLevel = 1;

  const hud = new Hud(uiHost, {
    fortressName: () => active.fortressName,
    mode: active.mode,
    onSpeedChange(s: SpeedLevel) {
      if (s !== 0) lastRunSpeed = s;
      clock.setSpeed(s);
    },
    async onSave() {
      await persist(active, camera);
      flashSave();
    },
    worldSeed: () => sim.seed,
    onShowTutorial: () => {
      void showTutorial(uiHost);
    },
    onShowHistory: () => {
      historyPanel.open(active.sim);
    },
    onShowResearch: () => {
      researchPanel.open(active.sim);
    },
    onShowPopulation: () => {
      if (populationPanel) populationPanel.open(active.sim);
    },
    onRenameFortress: async () => {
      const next = await showPrompt(uiHost, "Rename the fortress", active.fortressName);
      if (next && next.trim()) {
        active.fortressName = next.trim().slice(0, 60);
        void persist(active, camera);
      }
    },
    onQuitToTitle: () => {
      void quitToTitle();
    },
  });
  const eventPanel = new EventLogPanel(uiHost);
  const inspector = new DwarfInspector(uiHost);
  populationPanel = new PopulationPanel(uiHost, inspector, camera);
  const sliders = new SliderPanel(uiHost, sim);
  const emergency = new EmergencyPanel(uiHost, sim);
  const hints = new HintCenter(uiHost, sim);

  // ---- Input: pan + zoom only. The dwarves act on their own. ----
  // Touch pinch-zoom: track active pointers; with two down, each
  // 25% change in their separation steps one zoom level.
  const touches = new Map<number, { x: number; y: number }>();
  let pinchBase = 0;
  const pinchDistance = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      pinchBase = pinchDistance();
      panStart = null;
      isPanning = true; // suppress the click-to-inspect on release
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || pinchBase <= 0) return;
    const d = pinchDistance();
    const pts = [...touches.values()];
    const mid = camera.screenToTile((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, viewW, viewH);
    if (d > pinchBase * 1.25) { camera.zoomBy(+1, mid.x, mid.y); pinchBase = d; }
    else if (d < pinchBase * 0.8) { camera.zoomBy(-1, mid.x, mid.y); pinchBase = d; }
  });
  const endTouch = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchBase = 0;
  };
  canvas.addEventListener("pointerup", endTouch);
  canvas.addEventListener("pointercancel", endTouch);

  canvas.addEventListener("pointerdown", (e) => {
    if (touches.size >= 2) return;
    // Clicking the minimap jumps the camera there instead of panning.
    const mmTile = isPanelVisible("minimap") ? minimap.tileAtScreen(e.clientX, e.clientY) : null;
    if (mmTile) {
      camera.x = mmTile.x;
      camera.y = mmTile.y;
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    panStart = { mx: e.clientX, my: e.clientY, cx: camera.x, cy: camera.y };
    isPanning = false;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (touches.size >= 2) return;
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
      } else if (showGraveTooltip(active.sim, tx, ty, e.clientX, e.clientY)) {
        // Headstone — tooltip handled separately. Close the dwarf
        // inspector so the two UIs don't overlap.
        inspector.close();
      } else {
        // Click on empty space closes the inspector + any tooltip.
        inspector.close();
        hideGraveTooltip();
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    // Keyboard camera: WASD / arrows pan a fraction of the viewport,
    // +/- zoom around the viewport centre.
    const panStep = Math.max(4, Math.round(Math.min(viewW, viewH) / camera.pxPerTile / 6));
    const panKeys: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], KeyA: [-1, 0],
      ArrowRight: [1, 0], KeyD: [1, 0],
      ArrowUp: [0, -1], KeyW: [0, -1],
      ArrowDown: [0, 1], KeyS: [0, 1],
    };
    const dir = panKeys[e.code];
    if (dir) {
      e.preventDefault();
      camera.pan(dir[0] * panStep, dir[1] * panStep);
      return;
    }
    if (e.key === "+" || e.key === "=") { camera.zoomBy(+1, camera.x, camera.y); return; }
    if (e.key === "-" || e.key === "_") { camera.zoomBy(-1, camera.x, camera.y); return; }
    if (e.code === "Space") {
      e.preventDefault();
      if (clock.speed === 0) {
        clock.setSpeed(lastRunSpeed);
      } else {
        lastRunSpeed = clock.speed;
        clock.setSpeed(0);
      }
    } else if (e.key === "1") { lastRunSpeed = 1; clock.setSpeed(1); }
    else if (e.key === "2") { lastRunSpeed = 4; clock.setSpeed(4); }
    else if (e.key === "3") { lastRunSpeed = 16; clock.setSpeed(16); }
  });

  // ---- Auto-save lifecycle ----
  let lastAutoSaveMs = performance.now();
  // Legacy restore points land at each season boundary.
  let lastCheckpointSeason = Math.floor(sim.tick / TICKS_PER_SEASON);
  let fallHandled = active.fallenAtTick !== undefined;
  let quitting = false;
  async function quitToTitle(): Promise<void> {
    if (quitting) return;
    quitting = true;
    clock.setSpeed(0);
    await persist(active, camera);
    // persist() may have queued a trailing write; wait for it too.
    while (saveInFlight) await saveInFlight;
    window.location.reload();
  }
  async function handleFall(): Promise<void> {
    clock.setSpeed(0);
    active.fallenAtTick = sim.tick;
    // From here on the slot is only written explicitly.
    quitting = true;
    sim.events.add(sim.tick, "crisis", `${active.fortressName} has fallen. No dwarf remains to keep its fires.`);
    await persist(active, camera);
    while (saveInFlight) await saveInFlight;
    const choice = await showFallScreen(uiHost, {
      fortressName: active.fortressName,
      mode: active.mode,
      slotId: active.slotId,
      fellAtTick: sim.tick,
      graves: sim.graves.length,
      artifacts: sim.artifacts.length,
      books: sim.books.length,
      lastWords: sim.events.events.slice(-6).map((e) => ({ tick: e.tick, category: e.category, text: e.text })),
    });
    // "restored" rewrote the slot; either way reload into the title
    // screen (a restored slot continues from there).
    void choice;
    window.location.reload();
  }
  // While quitting / after a fall the slot has already been written
  // (possibly replaced by a restore point) — an unload-time save would
  // clobber it with the stale in-memory fortress.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !quitting) {
      void persist(active, camera);
    }
  });
  window.addEventListener("beforeunload", () => {
    if (!quitting) void persist(active, camera);
  });

  // ---- Game loop ----
  // Sound trigger: when the chronicle grows, play a category-tagged
  // motif for the new entries. We also rate-limit to one sound per
  // category per frame so a single tick that produces a milestone +
  // a crisis + four constructions doesn't sound like a slot machine.
  // Diff the monotonic add-counter, not the array length — once the
  // chronicle hits its cap, eviction keeps the length flat while new
  // entries keep landing at the tail.
  let lastEventSeq = sim.events.seq;
  let lastFrame = performance.now();
  // A persistent sim error would otherwise retry (and log) every frame
  // forever; after a few consecutive failures we pause the clock so the
  // player can read the chronicle and save.
  let consecutiveTickErrors = 0;
  // Emergency mode at the end of the previous frame. A change seen at
  // the start of a frame was the player pressing a button, so the
  // crisis lines it produces shouldn't trigger pause-on-crisis.
  let lastFrameEmergency = sim.emergency.mode;
  function frame(now: number) {
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;
    const playerToggledEmergency = sim.emergency.mode !== lastFrameEmergency;

    const ticks = clock.consume(dt);
    for (let i = 0; i < ticks; i++) {
      try {
        tick(sim);
        consecutiveTickErrors = 0;
      } catch (err) {
        // Last-resort net so a sim regression doesn't black-screen
        // the game. The sim's own paths handle entity-cap overflow
        // gracefully via -1 sentinels; this catches everything
        // else so the player can see the chronicle and save.
        // eslint-disable-next-line no-console -- deliberate: surface the stack in devtools
        console.error("tick failed", err);
        sim.events.add(
          sim.tick,
          "crisis",
          `A sim error skipped a tick: ${err instanceof Error ? err.message : String(err)}`,
        );
        consecutiveTickErrors++;
        if (consecutiveTickErrors >= 3) {
          clock.setSpeed(0);
          sim.events.add(
            sim.tick,
            "crisis",
            "Repeated sim errors — the game is paused. Save your fortress and reload.",
          );
        }
        break;
      }
    }

    if (now - lastAutoSaveMs >= AUTOSAVE_INTERVAL_MS) {
      lastAutoSaveMs = now;
      void persist(active, camera);
    }
    const season = Math.floor(sim.tick / TICKS_PER_SEASON);
    if (season !== lastCheckpointSeason) {
      lastCheckpointSeason = season;
      if (active.mode === "legacy" && !fallHandled) void checkpoint(active, camera);
    }
    if (!fallHandled && sim.dwarf.size() === 0) {
      fallHandled = true;
      void handleFall();
    }

    // Play sounds for any chronicle entries added this frame, deduped
    // by category so a busy tick doesn't overflow the audio bus.
    const seq = sim.events.seq;
    const fresh = seq > lastEventSeq ? sim.events.events.slice(-(seq - lastEventSeq)) : [];
    hints.observe(sim, fresh);
    if (seq > lastEventSeq) {
      const played = new Set<string>();
      for (const ev of fresh) {
        if (played.has(ev.category)) continue;
        played.add(ev.category);
        playEventSound(ev.category);
      }
      lastEventSeq = seq;
      if (
        getPauseOnCrisis() &&
        clock.speed !== 0 &&
        !playerToggledEmergency &&
        fresh.some((ev) => ev.category === "crisis")
      ) {
        lastRunSpeed = clock.speed;
        clock.setSpeed(0);
      }
    }

    lastFrameEmergency = sim.emergency.mode;
    minimap.refresh(sim, now);

    renderWorld(ctx, sim, camera, viewW, viewH);

    if (isPanelVisible("minimap")) {
      const mx = viewW - minimap.width - 14;
      const my = viewH - minimap.height - 14;
      minimap.draw(ctx, mx, my, camera, viewW, viewH);
    } else {
      minimap.clearDrawn();
    }

    hud.update(clock, sim);
    eventPanel.update(sim.events.events);
    inspector.update(sim);
    emergency.update();
    sliders.update();
    notifications.refresh(sim, now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Find a grave at (tx, ty) and show a small floating tooltip with
 * the buried dwarf's epitaph. Returns true if a grave was found. */
function showGraveTooltip(sim: SimWorld, tx: number, ty: number, screenX: number, screenY: number): boolean {
  const grave = sim.graves.find((g) => g.x === tx && g.y === ty);
  if (!grave) return false;
  let tooltip = document.getElementById("grave-tooltip") as HTMLDivElement | null;
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "grave-tooltip";
    tooltip.style.cssText =
      "position:fixed;background:#1a1410;border:1px solid #4a4030;padding:8px 12px;color:#cdb88a;font-family:monospace;font-size:11px;line-height:1.4;z-index:30;pointer-events:none;max-width:240px;";
    uiHost.appendChild(tooltip);
  }
  const yearOfDeath = Math.floor(grave.deathTick / 34560) + 1;
  tooltip.innerHTML = `
    <div style="color:#e0c080;font-size:12px;">${escapeHtml(grave.name)}</div>
    <div style="color:#999;">${escapeHtml(grave.profession)}, aged ${grave.ageAtDeath}</div>
    <div style="color:#888;margin-top:4px;">${escapeHtml(grave.cause)}</div>
    <div style="color:#666;font-size:10px;margin-top:4px;">Year ${yearOfDeath}</div>
  `;
  tooltip.style.left = `${Math.min(screenX + 12, window.innerWidth - 260)}px`;
  tooltip.style.top = `${Math.min(screenY + 12, window.innerHeight - 100)}px`;
  tooltip.style.display = "block";
  return true;
}

function hideGraveTooltip(): void {
  const tooltip = document.getElementById("grave-tooltip");
  if (tooltip) tooltip.style.display = "none";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
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
let saveQueued: { active: ActiveFortress; camera: Camera } | null = null;
async function persist(active: ActiveFortress, camera: Camera): Promise<void> {
  if (saveInFlight) {
    // A save is mid-write. Queue exactly one trailing save with the
    // freshest state — returning the stale in-flight promise used to
    // silently drop the newest snapshot on tab-hide / unload.
    saveQueued = { active, camera };
    return saveInFlight;
  }
  const save = snapshotActive(active, camera);
  saveInFlight = saveGame(save).finally(() => {
    saveInFlight = null;
    if (saveQueued) {
      const next = saveQueued;
      saveQueued = null;
      void persist(next.active, next.camera);
    }
  });
  return saveInFlight;
}

function snapshotActive(active: ActiveFortress, camera: Camera): SaveData {
  return snapshot({
    sim: active.sim,
    slotId: active.slotId,
    fortressName: active.fortressName,
    mode: active.mode,
    fallenAtTick: active.fallenAtTick,
    cameraX: camera.x,
    cameraY: camera.y,
    zoomIndex: camera.zoomIndex,
  });
}

/** Record a Legacy restore point. Failures are logged, not fatal —
 * the live save is unaffected. */
async function checkpoint(active: ActiveFortress, camera: Camera): Promise<void> {
  try {
    await saveCheckpoint(snapshotActive(active, camera));
  } catch (err) {
    // eslint-disable-next-line no-console -- deliberate: a failed restore point is non-fatal but worth a stack
    console.error("checkpoint failed", err);
  }
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
