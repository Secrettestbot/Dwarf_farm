// Bottom-anchored panel that streams the colony's event log. Shows the
// most recent N entries, color-coded by category, with the in-game day
// of each event so the player can see *when* things happened — not just
// what.

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

export class EventLogPanel {
  private root: HTMLElement;
  private list: HTMLElement;
  /** Tick of the last event we rendered, used to skip pointless DOM updates. */
  private lastRenderedTick = -1;
  private lastSize = 0;

  constructor(host: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "panel";
    wrap.style.cssText =
      "position:absolute;left:8px;bottom:8px;width:380px;max-width:45vw;padding:8px 10px;font-size:11px;line-height:1.45;color:#aaa;display:flex;flex-direction:column;gap:4px;";
    wrap.innerHTML = `
      <div style="font-size:10px;letter-spacing:2px;color:#888;text-transform:uppercase;">Event Log</div>
      <div id="event-log-list" style="display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto;"></div>
    `;
    host.appendChild(wrap);
    this.root = wrap;
    this.list = wrap.querySelector("#event-log-list") as HTMLElement;
  }

  /** Re-render only when the log size or last-event tick has changed. */
  update(events: LogEvent[]): void {
    const last = events.length > 0 ? events[events.length - 1] : null;
    const lastTick = last?.tick ?? -1;
    if (events.length === this.lastSize && lastTick === this.lastRenderedTick) return;
    this.lastSize = events.length;
    this.lastRenderedTick = lastTick;

    const recent = events.slice(Math.max(0, events.length - MAX_VISIBLE));
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
