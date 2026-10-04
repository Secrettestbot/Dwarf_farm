// Fortress-fall screen and Legacy restore-point picker.
//
// When the last dwarf dies the run ends. Saga fortresses become a
// read-only memorial on the title screen; Legacy fortresses can roll
// back to one of their seasonal restore points.

import { listCheckpoints, saveGame } from "../save/db";
import { SavedLogEvent, SaveData } from "../save/schema";
import { formatGameDate, TICKS_PER_DAY, TICKS_PER_YEAR } from "../sim/time";
import { showDialog } from "./dialog";

export interface FallSummary {
  fortressName: string;
  mode: "legacy" | "saga";
  slotId: string;
  fellAtTick: number;
  graves: number;
  artifacts: number;
  books: number;
  /** Most recent chronicle lines, oldest first. */
  lastWords: SavedLogEvent[];
}

export type FallChoice = "title" | "restored";

export async function showFallScreen(host: HTMLElement, summary: FallSummary): Promise<FallChoice> {
  const years = Math.floor(summary.fellAtTick / TICKS_PER_YEAR);
  const days = Math.max(1, Math.floor(summary.fellAtTick / TICKS_PER_DAY));
  const span = years >= 1 ? `${years} year${years === 1 ? "" : "s"}` : `${days} day${days === 1 ? "" : "s"}`;
  const body = document.createElement("div");
  body.style.cssText = "margin-bottom:14px;";
  body.innerHTML = `
    <div style="color:#aaa;margin-bottom:10px;">
      The last of ${escapeHtml(summary.fortressName)} is gone. The mountain endured them for
      ${span} and will remember them in ${summary.graves} grave${summary.graves === 1 ? "" : "s"},
      ${summary.artifacts} artifact${summary.artifacts === 1 ? "" : "s"} and ${summary.books} book${summary.books === 1 ? "" : "s"}.
    </div>
    <div style="color:#888;font-size:10px;letter-spacing:2px;margin-bottom:4px;">THE FINAL ENTRIES</div>
    <div style="font-size:11px;color:#9a8a6a;line-height:1.5;border-left:2px solid #4a4030;padding-left:8px;">
      ${summary.lastWords.map((e) => `<div>${escapeHtml(e.text)}</div>`).join("") || "<div>Silence.</div>"}
    </div>
    <div style="color:#777;font-size:11px;margin-top:10px;">
      ${summary.mode === "saga"
        ? "This was a Saga. The slot becomes a memorial."
        : "This is a Legacy fortress. You may return to an earlier season."}
    </div>
  `;
  const checkpoints = summary.mode === "legacy" ? await listCheckpoints(summary.slotId) : [];
  for (;;) {
    const r = await showDialog<"title" | "restore">(host, {
      title: "The fortress has fallen",
      body,
      buttons: [
        ...(checkpoints.length > 0 ? [{ label: "Restore a season…", value: "restore" as const }] : []),
        { label: "Return to title", value: "title", tone: "primary" },
      ],
      dismissValue: "title",
    });
    if (r.value === "title") return "title";
    if (await pickRestorePoint(host, summary.slotId)) return "restored";
  }
}

/** Let the player choose a restore point and write it into the slot.
 * Returns true when a restore point was applied. */
export async function pickRestorePoint(host: HTMLElement, slotId: string): Promise<boolean> {
  const checkpoints = await listCheckpoints(slotId);
  if (checkpoints.length === 0) {
    await showDialog(host, {
      title: "No restore points yet",
      body: "Legacy fortresses keep a restore point at the turn of each season. None has been recorded for this one yet.",
      buttons: [{ label: "OK", value: null, tone: "primary" }],
      dismissValue: null,
    });
    return false;
  }
  const r = await showDialog<string | null>(host, {
    title: "Restore an earlier season",
    body: "The fortress will be rewound to the chosen point. Anything after it is lost.",
    buttons: [
      ...checkpoints.map((c) => ({
        label: `${formatGameDate(c.tick)} · ${c.population} dwarves`,
        value: c.key,
      })),
      { label: "Cancel", value: null },
    ],
    dismissValue: null,
  });
  const chosen = checkpoints.find((c) => c.key === r.value);
  if (!chosen) return false;
  await saveGame(prepareRestoredSave(chosen.save));
  return true;
}

/** A restore point is written back as the slot's live save. Reset the
 * wall-clock stamp so reopening it doesn't trigger a catch-up for the
 * whole time since the checkpoint was taken, and clear any fall. */
export function prepareRestoredSave(save: SaveData, nowMs = Date.now()): SaveData {
  const out: SaveData = { ...save, realTimestampMs: nowMs };
  delete out.fallenAtTick;
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
