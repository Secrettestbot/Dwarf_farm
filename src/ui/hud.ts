import { Clock, SPEED_LEVELS, SpeedLevel, TICKS_PER_HOUR, TICKS_PER_DAY } from "../sim/time";

export interface HudHandlers {
  onSpeedChange(s: SpeedLevel): void;
  onSave(): void;
  onPaintToggle(active: boolean): void;
  onClearZones(): void;
}

export interface HudState {
  paintMode: boolean;
}

export class Hud {
  private root: HTMLElement;
  private speedButtons: Map<SpeedLevel, HTMLButtonElement> = new Map();
  private clockLabel: HTMLDivElement;
  private dwarfLabel: HTMLDivElement;
  private paintButton: HTMLButtonElement;
  state: HudState = { paintMode: false };

  constructor(host: HTMLElement, handlers: HudHandlers) {
    const top = document.createElement("div");
    top.className = "panel";
    top.style.cssText =
      "position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:6px;min-width:230px;";
    top.innerHTML = `<div style="color:#e0c080;font-size:13px;letter-spacing:2px;">⛏ DWARVEN DEEP</div>`;

    this.clockLabel = document.createElement("div");
    this.clockLabel.style.fontSize = "11px";
    this.clockLabel.style.color = "#aaa";
    top.appendChild(this.clockLabel);

    this.dwarfLabel = document.createElement("div");
    this.dwarfLabel.style.fontSize = "11px";
    this.dwarfLabel.style.color = "#888";
    top.appendChild(this.dwarfLabel);

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
    this.paintButton = document.createElement("button");
    this.paintButton.className = "btn";
    this.paintButton.textContent = "Dig Zone";
    this.paintButton.title = "Drag a rectangle on the world to mark a Dig Zone — dwarves prefer to mine inside it.";
    this.paintButton.addEventListener("click", () => {
      this.state.paintMode = !this.state.paintMode;
      handlers.onPaintToggle(this.state.paintMode);
      this.paintButton.classList.toggle("active", this.state.paintMode);
    });
    tools.appendChild(this.paintButton);

    const clearButton = document.createElement("button");
    clearButton.className = "btn";
    clearButton.textContent = "Clear Zones";
    clearButton.addEventListener("click", () => handlers.onClearZones());
    tools.appendChild(clearButton);

    const saveButton = document.createElement("button");
    saveButton.className = "btn";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", () => handlers.onSave());
    tools.appendChild(saveButton);

    top.appendChild(tools);

    const help = document.createElement("div");
    help.style.cssText = "font-size:10px;color:#666;line-height:1.4;margin-top:6px;";
    help.innerHTML =
      "Drag empty space to pan · scroll to zoom<br/>The dwarf works on its own — you only watch.";
    top.appendChild(help);

    host.appendChild(top);
    this.root = top;
  }

  update(clock: Clock, dwarfCount: number): void {
    const tick = clock.tick;
    const day = Math.floor(tick / TICKS_PER_DAY) + 1;
    const hour = Math.floor((tick % TICKS_PER_DAY) / TICKS_PER_HOUR);
    const min = tick % TICKS_PER_HOUR;
    this.clockLabel.textContent = `Day ${day} · ${pad(hour)}:${pad(min)}  (tick ${tick})`;
    this.dwarfLabel.textContent = `${dwarfCount} dwarf${dwarfCount === 1 ? "" : "ves"}`;
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
