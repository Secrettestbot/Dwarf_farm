import { listSaves, deleteSave } from "../save/db";
import { SaveV1 } from "../save/schema";

export interface TitleChoice {
  kind: "new" | "continue";
  slotId: string;
  seed?: number;
  existingSave?: SaveV1;
}

export async function showTitleScreen(host: HTMLElement): Promise<TitleChoice> {
  return new Promise(async (resolve) => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;inset:0;background:#0a0a0e;color:#ddd;display:flex;align-items:center;justify-content:center;font-family:inherit;";
    const card = document.createElement("div");
    card.style.cssText = "max-width:520px;width:90%;text-align:center;";
    card.innerHTML = `
      <div style="font-size:14px;letter-spacing:6px;color:#888;margin-bottom:8px;">⛏  DWARVEN DEEP</div>
      <h1 style="font-size:32px;margin:0 0 12px;color:#e0c080;">A Living Mountain</h1>
      <div style="font-size:12px;color:#777;margin-bottom:32px;">An idle colony simulation.<br/>The mountain is patient. So are the dwarves.</div>
      <div id="title-actions" style="display:flex;flex-direction:column;gap:10px;align-items:center;"></div>
      <div id="title-foot" style="margin-top:32px;font-size:11px;color:#555;">
        Session 1: simulation foundation. Save slots, founders, and priority sliders arrive in session 2.
      </div>
    `;
    root.appendChild(card);
    host.appendChild(root);

    const actions = card.querySelector("#title-actions") as HTMLElement;
    const saves = await listSaves();
    const existing = saves.find((s) => s.slotId === "slot0") ?? null;

    if (existing) {
      const elapsed = Date.now() - existing.realTimestampMs;
      const cont = makeButton(
        `Continue · last seen ${formatElapsed(elapsed)} ago · tick ${existing.tick}`,
      );
      cont.style.minWidth = "320px";
      cont.addEventListener("click", () => {
        cleanup();
        resolve({ kind: "continue", slotId: "slot0", existingSave: existing });
      });
      actions.appendChild(cont);
    }

    const newGame = makeButton("New Game");
    newGame.style.minWidth = "320px";
    newGame.addEventListener("click", () => {
      const seed = Math.floor(Math.random() * 0x7fffffff);
      cleanup();
      resolve({ kind: "new", slotId: "slot0", seed });
    });
    actions.appendChild(newGame);

    if (existing) {
      const wipe = makeButton("Abandon Fortress (wipe save)");
      wipe.style.minWidth = "320px";
      wipe.style.opacity = "0.5";
      wipe.style.fontSize = "11px";
      wipe.addEventListener("click", async () => {
        if (!confirm("Permanently delete the current fortress?")) return;
        await deleteSave("slot0");
        wipe.remove();
        const cont = card.querySelector("button");
        if (cont && cont.textContent?.startsWith("Continue")) cont.remove();
      });
      actions.appendChild(wipe);
    }

    function cleanup() {
      root.remove();
    }
  });
}

function makeButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = label;
  b.style.padding = "10px 20px";
  b.style.fontSize = "14px";
  return b;
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
