import { SimWorld } from "../sim/world/simWorld";
import {
  EVACUATE_COOLDOWN_TICKS,
  isShelterMode,
} from "../sim/emergency";

/**
 * Three large, instant emergency buttons (GDD §4.3) — Alarm, Evacuate,
 * Lockdown. Distinct from the priority sliders: sliders are gradual and
 * persistent, buttons are immediate and temporary. Each button is
 * disabled while its cooldown is active.
 *
 * Most of the GDD effects (military rally, doors barring, caravans
 * turning back) require systems that arrive in later sessions. The
 * minimum viable implementation here:
 * - Alarm pulls civilians to the spawn / Safe Zone for one in-game hour.
 * - Evacuate pulls everyone to the Safe Zone until cancelled.
 * - Lockdown blocks immigrant arrivals until cancelled.
 */
export class EmergencyPanel {
  private root: HTMLDivElement;
  private alarmBtn!: HTMLButtonElement;
  private evacBtn!: HTMLButtonElement;
  private lockBtn!: HTMLButtonElement;
  private statusLabel!: HTMLDivElement;

  constructor(host: HTMLElement, private sim: SimWorld) {
    const root = document.createElement("div");
    root.className = "panel";
    root.style.cssText =
      "position:absolute;left:8px;bottom:240px;display:flex;flex-direction:column;gap:4px;min-width:240px;";

    const title = document.createElement("div");
    title.style.cssText = "color:#888;font-size:10px;letter-spacing:3px;margin-bottom:2px;";
    title.textContent = "EMERGENCY";
    root.appendChild(title);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
    this.alarmBtn = makeBtn(row, "🜲 Alarm", "#e0a040", () => this.toggleAlarm());
    this.evacBtn = makeBtn(row, "↘ Evacuate", "#e07050", () => this.toggleEvacuate());
    this.lockBtn = makeBtn(row, "▮ Lockdown", "#7090e0", () => this.toggleLockdown());
    root.appendChild(row);

    this.statusLabel = document.createElement("div");
    this.statusLabel.style.cssText = "font-size:10px;color:#888;line-height:1.3;";
    root.appendChild(this.statusLabel);

    host.appendChild(root);
    this.root = root;
  }

  private toggleAlarm(): void {
    const e = this.sim.emergency;
    if (e.mode === "alarm") {
      // Manual cancel — same cooldown as auto-cancel.
      e.mode = "none";
      e.alarmCooldownUntil = this.sim.tick;
      this.sim.events.add(this.sim.tick, "crisis", "The alarm has been lifted.");
      return;
    }
    if (e.mode !== "none") return; // can't stack modes
    if (this.sim.tick < e.alarmCooldownUntil) return;
    e.mode = "alarm";
    e.startedAtTick = this.sim.tick;
    this.sim.events.add(
      this.sim.tick,
      "crisis",
      "The alarm has been sounded. The fortress takes up arms.",
    );
  }

  private toggleEvacuate(): void {
    const e = this.sim.emergency;
    if (e.mode === "evacuate") {
      e.mode = "none";
      e.evacuateCooldownUntil = this.sim.tick + EVACUATE_COOLDOWN_TICKS;
      this.sim.events.add(this.sim.tick, "crisis", "The evacuation has ended. The fortress emerges.");
      return;
    }
    if (e.mode !== "none") return;
    if (this.sim.tick < e.evacuateCooldownUntil) return;
    e.mode = "evacuate";
    e.startedAtTick = this.sim.tick;
    this.sim.events.add(
      this.sim.tick,
      "crisis",
      "Evacuation ordered. The fortress withdraws to the Safe Zone.",
    );
  }

  private toggleLockdown(): void {
    const e = this.sim.emergency;
    if (e.mode === "lockdown") {
      e.mode = "none";
      this.sim.events.add(this.sim.tick, "crisis", "Lockdown lifted. The gates open.");
      return;
    }
    if (e.mode !== "none") return;
    e.mode = "lockdown";
    e.startedAtTick = this.sim.tick;
    this.sim.events.add(
      this.sim.tick,
      "crisis",
      "Lockdown imposed. All external access is sealed.",
    );
  }

  refresh(sim: SimWorld): void {
    this.sim = sim;
    this.update();
  }

  update(): void {
    const e = this.sim.emergency;
    const tick = this.sim.tick;
    this.alarmBtn.classList.toggle("active", e.mode === "alarm");
    this.evacBtn.classList.toggle("active", e.mode === "evacuate");
    this.lockBtn.classList.toggle("active", e.mode === "lockdown");
    // Disable while a different mode is active or while cooldown is in
    // effect. The active-mode button stays clickable as a cancel button.
    this.alarmBtn.disabled =
      (e.mode !== "none" && e.mode !== "alarm") || (e.mode !== "alarm" && tick < e.alarmCooldownUntil);
    this.evacBtn.disabled =
      (e.mode !== "none" && e.mode !== "evacuate") || (e.mode !== "evacuate" && tick < e.evacuateCooldownUntil);
    this.lockBtn.disabled = e.mode !== "none" && e.mode !== "lockdown";

    let status = "";
    if (e.mode === "alarm") status = "Alarm sounded — civilians sheltering.";
    else if (e.mode === "evacuate") status = "Evacuation in progress.";
    else if (e.mode === "lockdown") status = "Locked down. Migration suspended.";
    else if (tick < e.alarmCooldownUntil) status = `Alarm cooldown: ${e.alarmCooldownUntil - tick} ticks.`;
    else if (tick < e.evacuateCooldownUntil) status = `Evacuate cooldown: ${e.evacuateCooldownUntil - tick} ticks.`;
    else status = "All quiet.";
    if (isShelterMode(e)) status += " Dwarves drop work to head to the Safe Zone.";
    this.statusLabel.textContent = status;
  }

  destroy(): void {
    this.root.remove();
  }
}

function makeBtn(
  parent: HTMLElement,
  label: string,
  color: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = label;
  b.style.color = color;
  b.style.flex = "1";
  b.addEventListener("click", onClick);
  parent.appendChild(b);
  return b;
}
