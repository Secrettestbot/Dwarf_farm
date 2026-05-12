import { generateWorld } from "./sim/world/worldgen";
import { SimWorld } from "./sim/world/simWorld";
import { tick } from "./sim/sim";
import { Clock, SpeedLevel, TICKS_PER_SECOND_AT_1X } from "./sim/time";
import { Camera } from "./render/camera";
import { renderWorld } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { Hud } from "./ui/hud";
import { SliderPanel } from "./ui/sliders";
import { EmergencyPanel } from "./ui/emergency";
import { EventLogPanel } from "./ui/eventLogPanel";
import { DwarfInspector } from "./ui/dwarfInspector";
import { showTitleScreen } from "./ui/titleScreen";
import { showFoundersScreen } from "./ui/foundersScreen";
import { showReturnScreen, showCatchupChoice } from "./ui/returnScreen";
import { restore, snapshot } from "./save/snapshot";
import { saveGame, loadGame } from "./save/db";
import { GameMode, SaveSlotId, SaveV1 } from "./save/schema";
import { WorkerToMain } from "./shared/protocol";
import { Founder } from "./sim/dwarves/founders";
import { narrateFounding } from "./sim/events/narrator";
import { playEventSound } from "./audio/sound";
import { showTutorial, tutorialAlreadySeen } from "./ui/tutorial";
import { HistoryPanel } from "./ui/historyPanel";
import { ResearchPanel } from "./ui/researchPanel";
import { PopulationPanel } from "./ui/populationPanel";
import { NotificationCenter } from "./ui/notificationCenter";

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
        screen.setStatus("Done. Building digest…");
        worker.terminate();
        // Restore + show the GDD §3.2 digest of what happened. The
        // chronicle entries from the catch-up window land in the
        // restored sim; we filter to just the new ones (tick > the
        // pre-catchup tick from the original save).
        const sim = restore(msg.save);
        const beforeTick = save.tick;
        const digestEvents = sim.events.events.filter((e) => e.tick > beforeTick);
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
  const clock = new Clock();
  clock.tick = sim.tick;
  clock.setSpeed(1);

  const minimap = new Minimap(sim.grid.width, sim.grid.height);
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

  const hud = new Hud(uiHost, {
    fortressName: () => active.fortressName,
    mode: active.mode,
    onSpeedChange(s: SpeedLevel) { clock.setSpeed(s); },
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
    onRenameFortress: () => {
      const next = window.prompt("Rename the fortress:", active.fortressName);
      if (next && next.trim()) {
        active.fortressName = next.trim().slice(0, 60);
        void persist(active, camera);
      }
    },
  });
  const eventPanel = new EventLogPanel(uiHost);
  const inspector = new DwarfInspector(uiHost);
  populationPanel = new PopulationPanel(uiHost, inspector, camera);
  const sliders = new SliderPanel(uiHost, sim);
  void sliders;
  const emergency = new EmergencyPanel(uiHost, sim);

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
  // Sound trigger: when the chronicle grows, play a category-tagged
  // motif for the new entries. We also rate-limit to one sound per
  // category per frame so a single tick that produces a milestone +
  // a crisis + four constructions doesn't sound like a slot machine.
  let lastEventCount = sim.events.size();
  let lastFrame = performance.now();
  function frame(now: number) {
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;

    const ticks = clock.consume(dt);
    for (let i = 0; i < ticks; i++) {
      try {
        tick(sim);
      } catch (err) {
        // Last-resort net so a sim regression doesn't black-screen
        // the game. The sim's own paths handle entity-cap overflow
        // gracefully via -1 sentinels; this catches everything
        // else so the player can see the chronicle and save.
        // eslint-disable-next-line no-console
        console.error("tick failed", err);
        sim.events.add(
          sim.tick,
          "crisis",
          `A sim error skipped a tick: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
    }

    autoSaveAccum += ticks;
    if (autoSaveAccum >= 60) {
      autoSaveAccum = 0;
      void persist(active, camera);
    }

    // Play sounds for any chronicle entries added this frame, deduped
    // by category so a busy tick doesn't overflow the audio bus.
    const evCount = sim.events.size();
    if (evCount > lastEventCount) {
      const played = new Set<string>();
      for (let i = lastEventCount; i < evCount; i++) {
        const cat = sim.events.events[i].category;
        if (played.has(cat)) continue;
        played.add(cat);
        playEventSound(cat);
      }
      lastEventCount = evCount;
    }

    minimap.refresh(sim, now);

    renderWorld(ctx, sim, camera, viewW, viewH);

    const mx = viewW - minimap.width - 14;
    const my = viewH - minimap.height - 14;
    minimap.draw(ctx, mx, my, camera, viewW, viewH);

    hud.update(clock, sim);
    eventPanel.update(sim.events.events);
    inspector.update(sim);
    emergency.update();
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
