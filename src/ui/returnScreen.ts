import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../sim/time";

/** A single chronicle entry surfaced in the post-catch-up digest. */
export interface DigestEntry {
  tick: number;
  category: string;
  text: string;
}

export interface ReturnScreenHandle {
  setProgress(done: number, total: number): void;
  setStatus(line: string): void;
  /** Replace the progress UI with a categorised digest of events from
   * the catch-up window (GDD §3.2). Returns a Promise that resolves
   * once the player clicks Continue. If onResume isn't provided, the
   * caller is expected to call close() manually. */
  showDigest(events: DigestEntry[], onResume: () => void): void;
  close(): void;
}

export function showReturnScreen(host: HTMLElement, elapsedMs: number, ticksToRun: number): ReturnScreenHandle {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;background:#0a0a0e;color:#ddd;display:flex;align-items:center;justify-content:center;font-family:inherit;z-index:100;";
  const card = document.createElement("div");
  card.style.cssText = "max-width:560px;width:90%;text-align:center;";
  const sec = Math.floor(elapsedMs / 1000);
  const realLabel = formatRealElapsed(sec);
  const igDays = Math.floor(ticksToRun / TICKS_PER_DAY);
  const igHours = Math.floor((ticksToRun % TICKS_PER_DAY) / TICKS_PER_HOUR);
  const igLabel = igDays > 0 ? `${igDays} day${igDays === 1 ? "" : "s"}, ${igHours}h` : `${igHours}h`;

  card.innerHTML = `
    <div style="font-size:14px;letter-spacing:6px;color:#888;margin-bottom:8px;">⛏  RETURNING</div>
    <h1 style="font-size:24px;margin:0 0 12px;color:#e0c080;">You were away for ${realLabel}.</h1>
    <div style="color:#aaa;margin-bottom:24px;">It has been <strong style="color:#e0c080;">${igLabel}</strong> in the mountain. Replaying events…</div>
    <div id="rs-status" style="color:#888;font-size:12px;margin-bottom:12px;">Restoring world from save…</div>
    <div style="background:#222;border:1px solid #444;height:14px;border-radius:2px;overflow:hidden;">
      <div id="rs-bar" style="background:#e0c080;height:100%;width:0%;transition:width 80ms linear;"></div>
    </div>
    <div id="rs-progress" style="margin-top:8px;font-size:11px;color:#666;"></div>
  `;
  root.appendChild(card);
  host.appendChild(root);

  const bar = card.querySelector("#rs-bar") as HTMLDivElement;
  const status = card.querySelector("#rs-status") as HTMLDivElement;
  const prog = card.querySelector("#rs-progress") as HTMLDivElement;

  return {
    setProgress(done, total) {
      const pct = total === 0 ? 100 : Math.min(100, Math.floor((done / total) * 100));
      bar.style.width = `${pct}%`;
      prog.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} ticks  (${pct}%)`;
    },
    setStatus(line) {
      status.textContent = line;
    },
    showDigest(events, onResume) {
      // Build the GDD §3.2 digest: deaths & injuries, births &
      // arrivals, discoveries, constructions, crises, milestones.
      // The categories on EventLog already line up with the GDD's
      // "social / discovery / construction / milestone / crisis"
      // taxonomy with one twist — births and deaths both live in
      // 'social', so we tag them by the verb that fires the event.
      const buckets: Record<string, DigestEntry[]> = {
        deaths: [],
        births: [],
        discoveries: [],
        constructions: [],
        crises: [],
        milestones: [],
      };
      for (const e of events) {
        if (e.category === "social" && /\b(died|dead|passed|did not wake|slain by|grieves|bereaved)\b/i.test(e.text)) {
          buckets.deaths.push(e);
        } else if (e.category === "social" && /\b(born|gave birth|first child|arrived at the gate|joined the fortress|walks out of the dust)\b/i.test(e.text)) {
          buckets.births.push(e);
        } else if (e.category === "social") {
          // Pairings, drafts, etc. — group under arrivals/social.
          buckets.births.push(e);
        } else if (e.category === "discovery") {
          buckets.discoveries.push(e);
        } else if (e.category === "construction") {
          buckets.constructions.push(e);
        } else if (e.category === "crisis") {
          buckets.crises.push(e);
        } else if (e.category === "milestone") {
          buckets.milestones.push(e);
        }
      }

      const labels: Array<[keyof typeof buckets, string, string]> = [
        ["milestones", "Milestones", "#ff9aa2"],
        ["deaths", "Deaths & Injuries", "#ff7060"],
        ["births", "Births, Arrivals & Bonds", "#9ad3a3"],
        ["discoveries", "Discoveries", "#ffd070"],
        ["constructions", "Constructions", "#a8c8e8"],
        ["crises", "Crises", "#ff7060"],
      ];

      const sections = labels
        .map(([key, label, color]) => {
          const entries = buckets[key];
          if (entries.length === 0) return "";
          // Cap each section so the digest doesn't scroll forever
          // — show the first few in each, with a "+N more" note.
          const MAX = 8;
          const shown = entries.slice(0, MAX);
          const extra = entries.length - shown.length;
          const items = shown
            .map((e) => {
              const day = Math.floor(e.tick / TICKS_PER_DAY) + 1;
              return `<div style="display:flex;gap:10px;align-items:flex-start;font-size:11px;line-height:1.5;color:#aaa;margin:2px 0;">
                <span style="color:#666;flex:0 0 auto;font-variant-numeric:tabular-nums;">d${day}</span>
                <span style="color:${color};">${escapeHtml(e.text)}</span>
              </div>`;
            })
            .join("");
          const footer = extra > 0
            ? `<div style="font-size:10px;color:#666;margin-top:4px;">… ${extra} more in the chronicle.</div>`
            : "";
          return `
            <div style="margin-top:14px;">
              <div style="font-size:10px;letter-spacing:2px;color:${color};text-transform:uppercase;margin-bottom:4px;">${label}</div>
              ${items}${footer}
            </div>`;
        })
        .filter((s) => s.length > 0)
        .join("");

      const empty = sections === "" ? `
        <div style="margin-top:24px;font-size:12px;color:#888;line-height:1.6;">
          The mountain was quiet while you were away. Nothing of note made it into the chronicle.
        </div>` : "";

      // Replace the card's progress UI with the digest + a Continue
      // button. Reuse the existing card so the framing — "you were
      // away for X" header — stays in place.
      card.innerHTML = `
        <div style="font-size:14px;letter-spacing:6px;color:#888;margin-bottom:8px;">⛏  WHILE YOU WERE AWAY</div>
        <h1 style="font-size:24px;margin:0 0 4px;color:#e0c080;">The mountain went on without you.</h1>
        <div style="color:#aaa;margin-bottom:8px;font-size:12px;">
          <strong style="color:#e0c080;">${realLabel}</strong> real ·
          <strong style="color:#e0c080;">${igLabel}</strong> in the mountain
        </div>
        <div style="text-align:left;max-height:60vh;overflow-y:auto;padding:0 8px;">
          ${sections}${empty}
        </div>
        <div style="margin-top:18px;">
          <button id="rs-continue" class="btn" style="padding:6px 18px;font-size:12px;">Continue</button>
        </div>
      `;
      const cont = card.querySelector("#rs-continue") as HTMLButtonElement | null;
      cont?.addEventListener("click", onResume);
    },
    close() {
      root.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function formatRealElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}
