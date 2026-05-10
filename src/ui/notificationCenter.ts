// Notification center — surfaces crisis-category events as toasts so
// the player doesn't have to scroll the chronicle to spot a death,
// brawl, or siege. Each toast carries an optional "jump to" button
// that pans the camera to the event's recorded tile (set on
// killDwarf, resolveBrawl, etc.).
//
// Toasts auto-dismiss after a few seconds; the player can dismiss
// early. The component polls the event log on every refresh tick
// and emits new crisis/milestone events as toasts; events from
// ticks before the panel was created are ignored so a save that
// loads thirty years of history doesn't drop a wall of toasts.

import { SimWorld } from "../sim/world/simWorld";
import { Camera } from "../render/camera";
import { LogEvent } from "../sim/events/eventLog";

const TOAST_LIFETIME_MS = 8000;
const MAX_TOASTS = 5;

interface ActiveToast {
  id: number;
  el: HTMLElement;
  expiresAt: number;
}

export class NotificationCenter {
  private root: HTMLElement;
  private host: HTMLElement;
  private toasts: ActiveToast[] = [];
  private nextId = 1;
  /** The most recent tick we've already processed. Anything in
   * sim.events.events with `tick > lastSeenTick` is candidate
   * material. We initialise this to the simulation's current tick
   * the first time `refresh` is called so we don't dump the entire
   * historical chronicle on screen. */
  private lastSeenTick: number = -1;
  private camera: Camera;

  constructor(host: HTMLElement, camera: Camera) {
    this.host = host;
    this.camera = camera;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      // Stack at top-left under the speed/HUD bar. Each toast is a
      // separate child div added at the top so newest sits highest.
      "position:absolute;top:60px;left:8px;display:flex;flex-direction:column;gap:6px;z-index:10;pointer-events:none;";
    this.host.appendChild(wrap);
    this.root = wrap;
  }

  /** Pump new events into toasts and prune expired ones. Call this
   * every frame from the game loop. */
  refresh(sim: SimWorld, now: number): void {
    if (this.lastSeenTick < 0) this.lastSeenTick = sim.tick;
    // Walk the tail of the event log for anything we haven't seen.
    const events = sim.events.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.tick <= this.lastSeenTick) break;
      if (!shouldToast(e)) continue;
      this.push(e, sim, now);
    }
    this.lastSeenTick = sim.tick;
    // Prune expired toasts.
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      if (this.toasts[i].expiresAt <= now) {
        this.dismiss(this.toasts[i].id);
      }
    }
  }

  private push(event: LogEvent, sim: SimWorld, now: number): void {
    // Cap stacked toasts — drop the oldest when we hit the cap so the
    // chronicle's latest line is always visible.
    while (this.toasts.length >= MAX_TOASTS) {
      this.dismiss(this.toasts[0].id);
    }
    const id = this.nextId++;
    const el = document.createElement("div");
    el.style.cssText =
      "background:rgba(40,20,20,0.95);border:1px solid #6a3030;color:#f0d8d8;padding:8px 10px;font:12px monospace;max-width:340px;border-radius:3px;display:flex;flex-direction:column;gap:4px;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,0.5);";
    const label = categoryLabel(event.category);
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <span style="font-size:10px;letter-spacing:2px;color:#e0a0a0;">${label}</span>
        <button class="toast-close" style="background:none;border:none;color:#888;cursor:pointer;font:11px monospace;padding:0;">×</button>
      </div>
      <div style="line-height:1.35;">${escapeHtml(event.text)}</div>
      ${event.x !== undefined && event.y !== undefined ? `<button class="toast-jump" style="align-self:flex-start;background:#3a2020;color:#e0c0c0;border:1px solid #6a3030;padding:2px 8px;font:11px monospace;cursor:pointer;">Jump to</button>` : ""}
    `;
    this.root.appendChild(el);
    const closeBtn = el.querySelector(".toast-close") as HTMLButtonElement | null;
    if (closeBtn) closeBtn.onclick = () => this.dismiss(id);
    const jumpBtn = el.querySelector(".toast-jump") as HTMLButtonElement | null;
    if (jumpBtn && event.x !== undefined && event.y !== undefined) {
      const x = event.x;
      const y = event.y;
      jumpBtn.onclick = () => {
        this.camera.x = x;
        this.camera.y = y;
        this.dismiss(id);
      };
    }
    this.toasts.push({ id, el, expiresAt: now + TOAST_LIFETIME_MS });
    void sim;
  }

  private dismiss(id: number): void {
    const idx = this.toasts.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const t = this.toasts[idx];
    t.el.remove();
    this.toasts.splice(idx, 1);
  }
}

/** Decide whether an event deserves a toast. Crisis and milestone
 * categories surface always; founding events surface too because
 * they're rare and important. Everything else stays in the chronicle. */
function shouldToast(e: LogEvent): boolean {
  return e.category === "crisis" || e.category === "milestone" || e.category === "founding";
}

function categoryLabel(c: string): string {
  if (c === "crisis") return "CRISIS";
  if (c === "milestone") return "MILESTONE";
  if (c === "founding") return "FOUNDING";
  if (c === "discovery") return "DISCOVERY";
  return c.toUpperCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
