// Contextual first-time hints. Each fires once per browser (tracked in
// localStorage) the first time its situation comes up in play, so the
// player learns the controls when they matter instead of all at once in
// the opening tutorial.

import { LogEvent } from "../sim/events/eventLog";
import { SimWorld } from "../sim/world/simWorld";

const STORAGE_KEY = "dwarven-deep:hintsSeen";

type HintId = "crisis" | "milestone" | "research" | "death" | "slider_off" | "hostile";

const HINTS: Record<HintId, string> = {
  crisis:
    "Crises show up as red notices. The Emergency buttons (bottom-left) are your only direct levers — hover them for what each does. If things move too fast, turn on “Pause on crisis” under Display.",
  milestone:
    "Milestones mark the fortress's history. The History button collects artifacts, books and graves.",
  research:
    "Your scholars finished a study and wrote a book about it. Raise the Research slider to put more dwarves at library desks; the Research button shows the tree.",
  death:
    "A dwarf has died. Click a headstone to read their epitaph — the mountain remembers everyone.",
  slider_off:
    "A priority slider near 0% switches that work off entirely. Between 0% and 50% caps how many dwarves take it on; above 50% pulls dwarves toward it first.",
  hostile:
    "Something hostile is in the mountain. Soldiers engage on their own; Alarm sends civilians to the Safe Zone while the squad holds the gate.",
};

function loadSeen(): Set<HintId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as HintId[]);
  } catch {
    // Unavailable or malformed — every hint is fresh.
  }
  return new Set();
}

export class HintCenter {
  private seen = loadSeen();
  private root: HTMLDivElement;
  private text: HTMLDivElement;
  private queue: HintId[] = [];
  private lastGraves: number;
  private lastBooks: number;
  private lastHostiles: number;

  constructor(host: HTMLElement, sim: SimWorld) {
    const root = document.createElement("div");
    root.className = "panel";
    root.setAttribute("role", "status");
    root.style.cssText =
      "position:absolute;left:50%;bottom:12px;transform:translateX(-50%);width:min(460px, calc(100vw - 32px));box-sizing:border-box;display:none;gap:10px;align-items:flex-start;z-index:20;border-color:#6a5a40;";
    const icon = document.createElement("div");
    icon.textContent = "💡";
    icon.setAttribute("aria-hidden", "true");
    root.appendChild(icon);
    this.text = document.createElement("div");
    this.text.style.cssText = "flex:1;color:#cdb88a;font-size:12px;line-height:1.45;";
    root.appendChild(this.text);
    const close = document.createElement("button");
    close.className = "btn";
    close.textContent = "Got it";
    close.style.cssText = "font-size:10px;padding:2px 8px;";
    close.addEventListener("click", () => this.next());
    root.appendChild(close);
    host.appendChild(root);
    this.root = root;
    this.lastGraves = sim.graves.length;
    this.lastBooks = sim.books.length;
    this.lastHostiles = sim.hostile.size();
  }

  /** Trigger a hint by id (no-op if already seen or queued). */
  trigger(id: HintId): void {
    if (this.seen.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
    if (this.queue.length === 1) this.show();
  }

  /** Inspect fresh chronicle entries and sim deltas for hint triggers. */
  observe(sim: SimWorld, fresh: ReadonlyArray<LogEvent>): void {
    for (const ev of fresh) {
      if (ev.category === "crisis") this.trigger("crisis");
      else if (ev.category === "milestone") this.trigger("milestone");
    }
    if (sim.graves.length > this.lastGraves) this.trigger("death");
    if (sim.books.length > this.lastBooks) this.trigger("research");
    const hostiles = sim.hostile.size();
    if (hostiles > this.lastHostiles) this.trigger("hostile");
    this.lastGraves = sim.graves.length;
    this.lastBooks = sim.books.length;
    this.lastHostiles = hostiles;
    for (const v of Object.values(sim.sliders)) {
      if (v <= 0.05) {
        this.trigger("slider_off");
        break;
      }
    }
  }

  private show(): void {
    const id = this.queue[0];
    if (!id) {
      this.root.style.display = "none";
      return;
    }
    this.text.textContent = HINTS[id];
    this.root.style.display = "flex";
  }

  private next(): void {
    const id = this.queue.shift();
    if (id) {
      this.seen.add(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.seen]));
      } catch {
        // Best-effort persistence.
      }
    }
    this.show();
  }
}
