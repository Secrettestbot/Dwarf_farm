import { SimWorld } from "../sim/world/simWorld";
import { SLIDER_KEYS, SLIDER_LABELS, SliderState } from "../sim/sliders";

/**
 * Right-side panel of ten priority sliders (GDD §4.1). The user adjusts a
 * slider; the value is written into `sim.sliders` immediately and read by
 * chooseTask on the next tick. No commit button — the colony is always
 * listening.
 *
 * Sliders for systems that don't exist yet (hauling, construction,
 * crafting, military, research, medicine) are visible but inert until
 * their underlying systems land in later sessions; they're labelled
 * accordingly so the player knows.
 */
export class SliderPanel {
  private root: HTMLDivElement;
  private valueLabels: Map<keyof SliderState, HTMLElement> = new Map();
  private inputs: Map<keyof SliderState, HTMLInputElement> = new Map();

  constructor(host: HTMLElement, private sim: SimWorld) {
    const root = document.createElement("div");
    root.className = "panel";
    root.style.cssText =
      "position:absolute;top:8px;right:8px;width:220px;display:flex;flex-direction:column;gap:4px;";

    const title = document.createElement("div");
    title.style.cssText = "color:#888;font-size:10px;letter-spacing:3px;margin-bottom:4px;";
    title.textContent = "PRIORITIES";
    root.appendChild(title);

    for (const key of SLIDER_KEYS) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;flex-direction:column;gap:1px;";
      const labelRow = document.createElement("div");
      labelRow.style.cssText =
        "display:flex;justify-content:space-between;font-size:10px;color:#aaa;";
      const left = document.createElement("span");
      left.textContent = SLIDER_LABELS[key];
      const right = document.createElement("span");
      right.style.color = "#e0c080";
      right.textContent = formatPercent(sim.sliders[key]);
      labelRow.appendChild(left);
      labelRow.appendChild(right);
      row.appendChild(labelRow);

      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "100";
      input.value = String(Math.round(sim.sliders[key] * 100));
      input.style.cssText = "width:100%;accent-color:#e0c080;";
      input.addEventListener("input", () => {
        const v = Math.max(0, Math.min(100, parseInt(input.value, 10) || 0)) / 100;
        sim.sliders[key] = v;
        right.textContent = formatPercent(v);
      });
      row.appendChild(input);
      this.inputs.set(key, input);
      this.valueLabels.set(key, right);
      root.appendChild(row);
    }

    const note = document.createElement("div");
    note.style.cssText = "font-size:9px;color:#666;line-height:1.4;margin-top:6px;";
    note.textContent =
      "Sliders bias the colony's autonomous job selection. Some categories activate only when their underlying systems land in later sessions.";
    root.appendChild(note);

    host.appendChild(root);
    this.root = root;
  }

  /** Re-read sim state — used after save/load swaps the SimWorld instance. */
  refresh(sim: SimWorld): void {
    this.sim = sim;
    for (const key of SLIDER_KEYS) {
      const input = this.inputs.get(key);
      const label = this.valueLabels.get(key);
      const v = sim.sliders[key];
      if (input) input.value = String(Math.round(v * 100));
      if (label) label.textContent = formatPercent(v);
    }
  }

  destroy(): void {
    this.root.remove();
  }
}

function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}
