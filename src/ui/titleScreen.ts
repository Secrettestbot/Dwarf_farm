import { listSlotSummaries, deleteSave, loadGame, saveGame } from "../save/db";
import { exportSaveToJson, importSaveFromJson } from "../save/transfer";
import { GameMode, SAVE_SLOT_IDS, SaveSlotId, SlotSummary } from "../save/schema";
import { BUNNY_BUTTON_ROWS, paintSpriteAtScale, SpriteSet } from "../render/sprites";
import { loadSpriteSet, saveSpriteSet } from "../render/spriteSetPref";
import { formatGameDate } from "../sim/time";
import { showConfirm, showDialog, showMessage } from "./dialog";
import { pickRestorePoint } from "./fallScreen";

export interface NewGameRequest {
  kind: "new";
  slotId: SaveSlotId;
  seed: number;
  mode: GameMode;
}

export interface ContinueRequest {
  kind: "continue";
  slotId: SaveSlotId;
}

export type TitleChoice = NewGameRequest | ContinueRequest;

/**
 * Title screen with up to 5 fortress slots. Each occupied slot shows the
 * fortress name, mode, population, and last-seen time. Empty slots show
 * "+ New Fortress". Selecting an empty slot leads to a mode-select sub-screen
 * before founders generation; selecting an occupied slot continues that
 * fortress.
 */
export async function showTitleScreen(host: HTMLElement): Promise<TitleChoice> {
  const summaries = await listSlotSummaries();
  const byId: Record<string, SlotSummary> = {};
  for (const s of summaries) byId[s.slotId] = s;

  return await chooseSlot(host, byId);
}

async function chooseSlot(host: HTMLElement, byId: Record<string, SlotSummary>): Promise<TitleChoice> {
  return new Promise((resolve) => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;inset:0;background:#0a0a0e;color:#ddd;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;";

    const card = document.createElement("div");
    card.style.cssText = "max-width:640px;width:100%;text-align:center;";
    card.innerHTML = `
      <div style="font-size:14px;letter-spacing:6px;color:#888;margin-bottom:8px;">⛏  DWARVEN DEEP</div>
      <h1 style="font-size:32px;margin:0 0 12px;color:#e0c080;">A Living Mountain</h1>
      <div style="font-size:12px;color:#777;margin-bottom:24px;">
        Choose a fortress. The mountain remembers each one separately.
      </div>
      <div id="slots" style="display:flex;flex-direction:column;gap:10px;align-items:stretch;text-align:left;"></div>
    `;
    root.appendChild(card);
    host.appendChild(root);

    // Bottom-right bunny button — opens the sprite-set selector so
    // the player can swap the colony's appearance between dwarves,
    // a mixed pool, and bunnies only. Persists to localStorage.
    root.appendChild(buildSpriteSetButton(root));

    const slotsHost = card.querySelector("#slots") as HTMLElement;
    for (const slotId of SAVE_SLOT_IDS) {
      const summary = byId[slotId];
      slotsHost.appendChild(buildSlotRow(slotId, summary, async (action) => {
        if (action === "continue" && summary) {
          root.remove();
          resolve({ kind: "continue", slotId });
        } else if (action === "new") {
          // Either fresh slot or a confirm-replace flow handled in buildSlotRow.
          const choice = await chooseMode(host);
          if (!choice) {
            // User cancelled; rebuild the title screen.
            const summaries = await listSlotSummaries();
            const map: Record<string, SlotSummary> = {};
            for (const s of summaries) map[s.slotId] = s;
            const next = await chooseSlot(host, map);
            resolve(next);
            return;
          }
          root.remove();
          resolve({ kind: "new", slotId, seed: choice.seed, mode: choice.mode });
        } else if (action === "delete") {
          if (!summary) return;
          const isMemorial = summary.fallenAtTick !== undefined && summary.mode === "saga";
          if (summary.mode === "saga" && !isMemorial) {
            // Saga: abandoning ends the run — the slot becomes a memorial.
            const ok = await showConfirm(
              host,
              `Abandon ${summary.fortressName}?`,
              "This is a Saga. The run ends permanently and the slot becomes a memorial.",
              "Abandon",
              true,
            );
            if (!ok) return;
            const save = await loadGame(slotId);
            if (save) {
              save.fallenAtTick = save.tick;
              await saveGame(save);
            }
          } else {
            const ok = await showConfirm(
              host,
              isMemorial ? `Clear the memorial to ${summary.fortressName}?` : `Abandon ${summary.fortressName}?`,
              "The slot and its chronicle are deleted permanently. This cannot be undone.",
              isMemorial ? "Clear" : "Abandon",
              true,
            );
            if (!ok) return;
            await deleteSave(slotId);
          }
          // Refresh.
          const summaries = await listSlotSummaries();
          const map: Record<string, SlotSummary> = {};
          for (const s of summaries) map[s.slotId] = s;
          const next = await chooseSlot(host, map);
          resolve(next);
        } else if (action === "export" && summary) {
          const save = await loadGame(slotId);
          if (save) downloadSaveFile(save.fortressName, exportSaveToJson(save));
        } else if (action === "import") {
          const imported = await pickSaveFile();
          if (imported === null) return;
          if (typeof imported === "string") {
            await showMessage(host, "Couldn't import that file", imported);
            return;
          }
          imported.slotId = slotId;
          await saveGame(imported);
          const summaries = await listSlotSummaries();
          const map: Record<string, SlotSummary> = {};
          for (const s of summaries) map[s.slotId] = s;
          const next = await chooseSlot(host, map);
          resolve(next);
        } else if (action === "restore") {
          if (await pickRestorePoint(host, slotId)) {
            root.remove();
            resolve({ kind: "continue", slotId });
          }
        } else if (action === "chronicle") {
          const save = await loadGame(slotId);
          if (save) await showChronicle(host, save.fortressName, save.events ?? []);
        }
      }));
    }
  });
}

type SlotAction = "continue" | "new" | "delete" | "export" | "import" | "restore" | "chronicle";

function buildSlotRow(
  slotId: SaveSlotId,
  summary: SlotSummary | undefined,
  onAction: (action: SlotAction) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel";
  wrap.style.cssText = "padding:12px 16px;display:flex;align-items:center;gap:14px;";

  if (!summary) {
    wrap.innerHTML = `
      <div style="flex:1;color:#888;">${labelForSlot(slotId)} <span style="color:#555;">— empty</span></div>
    `;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "+ New Fortress";
    btn.addEventListener("click", () => onAction("new"));
    wrap.appendChild(btn);
    const imp = document.createElement("button");
    imp.className = "btn";
    imp.textContent = "Import…";
    imp.title = "Load a fortress from an exported save file into this slot";
    imp.style.opacity = "0.6";
    imp.style.fontSize = "11px";
    imp.addEventListener("click", () => onAction("import"));
    wrap.appendChild(imp);
    return wrap;
  }

  const elapsed = Date.now() - summary.realTimestampMs;
  const fallen = summary.fallenAtTick !== undefined;
  const memorial = fallen && summary.mode === "saga";
  const modeBadge =
    summary.mode === "saga"
      ? `<span style="color:#ff8a5c;font-size:10px;letter-spacing:2px;">SAGA</span>`
      : `<span style="color:#789;font-size:10px;letter-spacing:2px;">LEGACY</span>`;
  const statusBadge = memorial
    ? ` <span style="color:#a99;font-size:10px;letter-spacing:2px;">✝ MEMORIAL</span>`
    : fallen
      ? ` <span style="color:#e07050;font-size:10px;letter-spacing:2px;">FALLEN</span>`
      : "";
  const detail = fallen
    ? `Fell in ${formatGameDate(summary.fallenAtTick!)}`
    : `${summary.population} ${summary.population === 1 ? "dwarf" : "dwarves"} · ${formatGameDate(summary.tick)} · last seen ${formatElapsed(elapsed)} ago`;

  wrap.innerHTML = `
    <div style="flex:1;">
      <div style="font-size:14px;color:${memorial ? "#a99" : "#e0c080"};">${escapeHtml(summary.fortressName)} ${modeBadge}${statusBadge}</div>
      <div style="font-size:11px;color:#888;margin-top:2px;">${detail}</div>
    </div>
  `;
  const addBtn = (label: string, action: SlotAction, title: string, primary = false) => {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.title = title;
    if (primary) {
      b.style.minWidth = "100px";
    } else {
      b.style.opacity = "0.6";
      b.style.fontSize = "11px";
    }
    b.addEventListener("click", () => onAction(action));
    wrap.appendChild(b);
  };

  if (memorial) {
    addBtn("Read chronicle", "chronicle", "Read the fallen fortress's chronicle", true);
    addBtn("Export", "export", "Download this fortress as a save file (backup / sharing)");
    addBtn("Clear", "delete", "Delete this memorial");
    return wrap;
  }
  if (!fallen) addBtn("Continue", "continue", "Return to this fortress", true);
  if (summary.mode === "legacy") {
    addBtn(fallen ? "Restore a season…" : "Restore…", "restore", "Rewind to a seasonal restore point", fallen);
  }
  addBtn("Export", "export", "Download this fortress as a save file (backup / sharing)");
  addBtn("Abandon", "delete", summary.mode === "saga" ? "End this Saga — the slot becomes a memorial" : "Delete this fortress");

  return wrap;
}

/** Read-only view of a fallen fortress's chronicle. */
async function showChronicle(
  host: HTMLElement,
  name: string,
  events: ReadonlyArray<{ tick: number; text: string }>,
): Promise<void> {
  const body = document.createElement("div");
  body.style.cssText =
    "font-size:11px;line-height:1.5;color:#9a8a6a;max-height:55vh;overflow:auto;border-left:2px solid #4a4030;padding-left:8px;margin-bottom:12px;";
  body.innerHTML = events.length === 0
    ? "<div>The chronicle is empty.</div>"
    : events
      .map((e) => `<div><span style="color:#666;">${formatGameDate(e.tick)}</span> — ${escapeHtml(e.text)}</div>`)
      .join("");
  await showDialog(host, {
    title: `The chronicle of ${name}`,
    body,
    buttons: [{ label: "Close", value: true, tone: "primary" }],
    dismissValue: true,
  });
}

function labelForSlot(slotId: SaveSlotId): string {
  const idx = SAVE_SLOT_IDS.indexOf(slotId);
  return `Slot ${idx + 1}`;
}

interface ModeChoice { mode: GameMode; seed: number; }

async function chooseMode(host: HTMLElement): Promise<ModeChoice | null> {
  return new Promise((resolve) => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;inset:0;background:#0a0a0e;color:#ddd;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;";

    const card = document.createElement("div");
    card.style.cssText = "max-width:560px;width:100%;text-align:center;";
    card.innerHTML = `
      <h2 style="color:#e0c080;margin:0 0 6px;">Choose how this fortress dies</h2>
      <div style="font-size:12px;color:#777;margin-bottom:24px;">
        This choice is permanent for this fortress.
      </div>
      <div id="modes" style="display:flex;flex-direction:column;gap:12px;text-align:left;"></div>
      <div id="seedrow" style="margin-top:24px;display:flex;gap:8px;align-items:center;justify-content:center;">
        <span style="font-size:11px;color:#666;">World seed</span>
        <input id="seed" class="btn" style="width:120px;text-align:center;" value="" placeholder="random"/>
        <button id="reroll" class="btn" style="font-size:11px;">↻</button>
      </div>
      <div style="margin-top:18px;display:flex;gap:8px;justify-content:center;">
        <button id="cancel" class="btn" style="opacity:0.7;">Back</button>
      </div>
    `;
    root.appendChild(card);
    host.appendChild(root);

    const modeHost = card.querySelector("#modes") as HTMLElement;

    function modeRow(mode: GameMode, title: string, body: string, recommended = false): HTMLElement {
      const row = document.createElement("button");
      row.className = "panel";
      row.style.cssText =
        "text-align:left;padding:14px 16px;cursor:pointer;border:1px solid #2a2a35;background:#15151b;color:#ddd;";
      row.innerHTML = `
        <div style="font-size:14px;color:#e0c080;">${title}${recommended ? ' <span style="font-size:10px;color:#789;letter-spacing:2px;">RECOMMENDED</span>' : ""}</div>
        <div style="font-size:12px;color:#aaa;line-height:1.5;margin-top:4px;">${body}</div>
      `;
      row.addEventListener("click", () => {
        const seed = parseSeedInput((card.querySelector("#seed") as HTMLInputElement).value);
        root.remove();
        resolve({ mode, seed });
      });
      return row;
    }

    modeHost.appendChild(
      modeRow(
        "legacy",
        "Legacy Mode",
        "Reloadable saves. Keeps a restore point at the turn of each season (the last three), so even a fallen fortress can be rewound. Recommended for most players — losing weeks of real-time progress to a single cave-in is punishing in a way that feels unfair rather than dramatic.",
        true,
      ),
    );
    modeHost.appendChild(
      modeRow(
        "saga",
        "Saga Mode",
        "One save, continuously overwritten. If the fortress falls — population reaches zero, or you choose to abandon — the run ends permanently. The slot becomes a memorial. Designed for players who want the full weight of consequence.",
      ),
    );

    const seedInput = card.querySelector("#seed") as HTMLInputElement;
    const seedReroll = card.querySelector("#reroll") as HTMLButtonElement;
    const refreshSeed = () => { seedInput.value = String(Math.floor(Math.random() * 0x7fffffff)); };
    refreshSeed();
    seedReroll.addEventListener("click", refreshSeed);

    (card.querySelector("#cancel") as HTMLButtonElement).addEventListener("click", () => {
      root.remove();
      resolve(null);
    });
  });
}

function parseSeedInput(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return Math.floor(Math.random() * 0x7fffffff);
  // Accept either a number or any string (which we hash).
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0 && n <= 0x7fffffff) return n | 0;
  // Hash arbitrary string seed.
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

/** Bottom-right bunny button. Clicking it opens the sprite-set
 * selector (dwarves / mixed / bunnies only). The choice is saved to
 * localStorage and applied to the live sprite pool so the next
 * render uses it immediately. */
function buildSpriteSetButton(root: HTMLElement): HTMLElement {
  const btn = document.createElement("button");
  btn.setAttribute("aria-label", "Sprite set");
  btn.title = "Sprite set";
  btn.style.cssText =
    "position:absolute;right:18px;bottom:18px;width:56px;height:56px;" +
    "padding:4px;background:#15151b;border:1px solid #2a2a35;border-radius:6px;" +
    "cursor:pointer;display:flex;align-items:center;justify-content:center;";
  const canvas = paintSpriteAtScale(BUNNY_BUTTON_ROWS, 3);
  canvas.style.cssText = "image-rendering:pixelated;width:48px;height:48px;";
  btn.appendChild(canvas);
  btn.addEventListener("mouseenter", () => { btn.style.borderColor = "#e0c080"; });
  btn.addEventListener("mouseleave", () => { btn.style.borderColor = "#2a2a35"; });
  btn.addEventListener("click", () => openSpriteSetPicker(root));
  return btn;
}

function openSpriteSetPicker(host: HTMLElement): void {
  const existing = host.querySelector("[data-sprite-picker]") as HTMLElement | null;
  if (existing) { existing.remove(); return; }
  const overlay = document.createElement("div");
  overlay.setAttribute("data-sprite-picker", "1");
  overlay.style.cssText =
    "position:absolute;inset:0;background:rgba(10,10,14,0.75);display:flex;" +
    "align-items:center;justify-content:center;z-index:10;";

  const card = document.createElement("div");
  card.className = "panel";
  card.style.cssText =
    "padding:18px 22px;min-width:280px;background:#15151b;border:1px solid #2a2a35;" +
    "border-radius:8px;color:#ddd;";
  const current = loadSpriteSet();
  card.innerHTML = `
    <div style="font-size:14px;color:#e0c080;margin-bottom:4px;">Sprite set</div>
    <div style="font-size:11px;color:#888;margin-bottom:14px;">
      Pick what the colony looks like.
    </div>
    <div id="options" style="display:flex;flex-direction:column;gap:6px;"></div>
    <div style="margin-top:14px;display:flex;justify-content:flex-end;">
      <button id="close" class="btn" style="font-size:11px;opacity:0.7;">Close</button>
    </div>
  `;
  const options = card.querySelector("#options") as HTMLElement;
  const choices: Array<{ id: SpriteSet; label: string; hint: string }> = [
    { id: "dwarves", label: "Dwarves only", hint: "16 bearded variants. The classic colony." },
    { id: "mixed", label: "Dwarves and bunnies", hint: "Mostly dwarves, a few bunnies." },
    { id: "bunnies", label: "Bunnies only", hint: "Every colonist is a bunny." },
  ];
  for (const c of choices) {
    const row = document.createElement("label");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 10px;" +
      "background:#1a1a22;border:1px solid #2a2a35;border-radius:4px;cursor:pointer;";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "spriteSet";
    radio.value = c.id;
    radio.checked = c.id === current;
    radio.addEventListener("change", () => {
      if (radio.checked) saveSpriteSet(c.id);
    });
    const text = document.createElement("div");
    text.innerHTML =
      `<div style="font-size:12px;color:#e0c080;">${c.label}</div>` +
      `<div style="font-size:10px;color:#888;">${c.hint}</div>`;
    row.appendChild(radio);
    row.appendChild(text);
    options.appendChild(row);
  }
  (card.querySelector("#close") as HTMLButtonElement).addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  host.appendChild(overlay);
}

/** Trigger a browser download of an exported save. */
function downloadSaveFile(fortressName: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = fortressName.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40) || "fortress";
  a.href = url;
  a.download = `${safeName}.dwarvendeep.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** File-picker + parse. Resolves to the parsed save, a string error
 * message for the user, or null if the picker was cancelled. */
function pickSaveFile(): Promise<import("../save/schema").SaveV1 | string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(importSaveFromJson(await file.text()));
      } catch (err) {
        resolve(err instanceof Error ? err.message : String(err));
      }
    });
    // Cancel produces no event in most browsers; resolve null when the
    // window regains focus without a selection.
    window.addEventListener("focus", () => {
      setTimeout(() => { if (!input.files?.length) resolve(null); }, 500);
    }, { once: true });
    input.click();
  });
}
