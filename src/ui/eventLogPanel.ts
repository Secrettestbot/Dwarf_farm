// Bottom-anchored panel that streams the colony's event log. Shows the
// most recent N entries, color-coded by category, with the in-game day
// of each event so the player can see *when* things happened — not just
// what. A row of category-toggle chips lets the player narrow the log
// to e.g. just deaths or just discoveries — handy for reading a long
// fortress's history without scrolling forever.

import { LogEvent } from "../sim/events/eventLog";
import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../sim/time";

const MAX_VISIBLE = 8;

const CATEGORY_COLOR: Record<string, string> = {
  founding: "#e0c080",
  discovery: "#ffd070",
  construction: "#a8c8e8",
  social: "#9ad3a3",
  milestone: "#ff9aa2",
  crisis: "#ff7060",
};

const FILTER_CATEGORIES: { id: string; label: string }[] = [
  { id: "discovery", label: "discoveries" },
  { id: "construction", label: "construction" },
  { id: "social", label: "social" },
  { id: "milestone", label: "milestones" },
  { id: "crisis", label: "crises" },
];

export class EventLogPanel {
  private root: HTMLElement;
  private list: HTMLElement;
  /** Tick of the last event we rendered, used to skip pointless DOM updates. */
  private lastRenderedTick = -1;
  private lastSize = 0;
  /** Active category filter set. Empty = show everything. */
  private filter: Set<string> = new Set();

  constructor(host: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "panel";
    wrap.style.cssText =
      "position:absolute;left:8px;bottom:8px;width:380px;max-width:45vw;padding:8px 10px;font-size:11px;line-height:1.45;color:#aaa;display:flex;flex-direction:column;gap:4px;";
    wrap.innerHTML = `
      <div style="font-size:10px;letter-spacing:2px;color:#888;text-transform:uppercase;">Event Log</div>
      <div id="event-log-filters" style="display:flex;flex-wrap:wrap;gap:4px;font-size:9px;"></div>
      <div id="event-log-list" style="display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto;"></div>
    `;
    host.appendChild(wrap);
    this.root = wrap;
    this.list = wrap.querySelector("#event-log-list") as HTMLElement;

    const filterHost = wrap.querySelector("#event-log-filters") as HTMLElement;
    for (const f of FILTER_CATEGORIES) {
      const chip = document.createElement("button");
      chip.className = "btn";
      chip.style.cssText = "font-size:9px;padding:2px 6px;border-radius:8px;";
      chip.textContent = f.label;
      chip.style.color = CATEGORY_COLOR[f.id] ?? "#aaa";
      chip.style.opacity = "0.5";
      chip.addEventListener("click", () => {
        if (this.filter.has(f.id)) this.filter.delete(f.id);
        else this.filter.add(f.id);
        chip.style.opacity = this.filter.has(f.id) ? "1" : "0.5";
        this.lastRenderedTick = -1; // force re-render
      });
      filterHost.appendChild(chip);
    }
  }

  /** Re-render only when the log size or last-event tick has changed. */
  update(events: LogEvent[]): void {
    const last = events.length > 0 ? events[events.length - 1] : null;
    const lastTick = last?.tick ?? -1;
    if (events.length === this.lastSize && lastTick === this.lastRenderedTick) return;
    this.lastSize = events.length;
    this.lastRenderedTick = lastTick;

    const filtered =
      this.filter.size === 0 ? events : events.filter((e) => this.filter.has(e.category));
    const recent = filtered.slice(Math.max(0, filtered.length - MAX_VISIBLE));
    this.list.innerHTML = recent
      .map((e) => {
        const day = Math.floor(e.tick / TICKS_PER_DAY) + 1;
        const hour = Math.floor((e.tick % TICKS_PER_DAY) / TICKS_PER_HOUR);
        const color = CATEGORY_COLOR[e.category] ?? "#aaa";
        return `
          <div style="display:flex;gap:8px;align-items:flex-start;">
            <span style="color:#666;font-variant-numeric:tabular-nums;flex:0 0 auto;">d${day} ${pad(hour)}h</span>
            <span style="color:${color};">${escapeHtml(e.text)}</span>
          </div>
        `;
      })
      .join("");
    // Auto-scroll to most-recent entry.
    this.list.scrollTop = this.list.scrollHeight;
  }

  destroy(): void {
    this.root.remove();
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
