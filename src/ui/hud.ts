import { Clock, SPEED_LEVELS, SpeedLevel, TICKS_PER_HOUR, TICKS_PER_DAY } from "../sim/time";
import { SimWorld } from "../sim/world/simWorld";
import { GameMode } from "../save/schema";

export interface HudHandlers {
  fortressName: string;
  mode: GameMode;
  onSpeedChange(s: SpeedLevel): void;
  onSave(): void;
}

export class Hud {
  private root: HTMLElement;
  private speedButtons: Map<SpeedLevel, HTMLButtonElement> = new Map();
  private clockLabel: HTMLDivElement;
  private dwarfLabel: HTMLDivElement;
  private plannerLabel: HTMLDivElement;

  constructor(host: HTMLElement, handlers: HudHandlers) {
    const top = document.createElement("div");
    top.className = "panel";
    top.style.cssText =
      "position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:6px;min-width:240px;";
    const modeBadge =
      handlers.mode === "saga"
        ? `<span style="color:#ff8a5c;font-size:9px;letter-spacing:2px;">SAGA</span>`
        : `<span style="color:#789;font-size:9px;letter-spacing:2px;">LEGACY</span>`;
    top.innerHTML = `
      <div style="color:#888;font-size:10px;letter-spacing:3px;">⛏ DWARVEN DEEP</div>
      <div style="color:#e0c080;font-size:14px;line-height:1.2;">${escapeHtml(handlers.fortressName)} ${modeBadge}</div>
    `;

    this.clockLabel = document.createElement("div");
    this.clockLabel.style.fontSize = "11px";
    this.clockLabel.style.color = "#aaa";
    top.appendChild(this.clockLabel);

    this.dwarfLabel = document.createElement("div");
    this.dwarfLabel.style.fontSize = "11px";
    this.dwarfLabel.style.color = "#888";
    top.appendChild(this.dwarfLabel);

    this.plannerLabel = document.createElement("div");
    this.plannerLabel.style.fontSize = "11px";
    this.plannerLabel.style.color = "#888";
    top.appendChild(this.plannerLabel);

    const speedRow = document.createElement("div");
    speedRow.style.cssText = "display:flex;gap:4px;margin-top:4px;";
    for (const s of SPEED_LEVELS) {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = s === 0 ? "‖" : `${s}×`;
      b.title = s === 0 ? "Pause" : `${s}× speed`;
      b.style.minWidth = "40px";
      b.addEventListener("click", () => handlers.onSpeedChange(s));
      speedRow.appendChild(b);
      this.speedButtons.set(s, b);
    }
    top.appendChild(speedRow);

    const tools = document.createElement("div");
    tools.style.cssText = "display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;";
    const saveButton = document.createElement("button");
    saveButton.className = "btn";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", () => handlers.onSave());
    tools.appendChild(saveButton);
    top.appendChild(tools);

    const help = document.createElement("div");
    help.style.cssText = "font-size:10px;color:#666;line-height:1.4;margin-top:6px;";
    help.innerHTML =
      "Drag to pan · scroll to zoom · space pauses<br/>The dwarves work on their own. You only watch.";
    top.appendChild(help);

    host.appendChild(top);
    this.root = top;
  }

  update(clock: Clock, sim: SimWorld): void {
    const tick = clock.tick;
    const day = Math.floor(tick / TICKS_PER_DAY) + 1;
    const hour = Math.floor((tick % TICKS_PER_DAY) / TICKS_PER_HOUR);
    const min = tick % TICKS_PER_HOUR;
    this.clockLabel.textContent = `Day ${day} · ${pad(hour)}:${pad(min)}  (tick ${tick})`;
    const dwarfCount = sim.dwarf.size();
    this.dwarfLabel.textContent = `${dwarfCount} dwarf${dwarfCount === 1 ? "" : "ves"}`;
    const active = sim.planner.activeCount();
    const built = sim.planner.completed;
    this.plannerLabel.textContent = `Plans: ${active} digging · ${built} done`;
    for (const [s, b] of this.speedButtons) {
      b.classList.toggle("active", s === clock.speed);
    }
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
