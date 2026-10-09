import { SimWorld } from "../sim/world/simWorld";
import { SLIDER_KEYS, SLIDER_LABELS, SliderState } from "../sim/sliders";
import { attachPanelVisibility } from "./displaySettings";
import { LABOR_CATEGORIES, LaborCategory, laborSnapshot } from "../sim/jobs/laborWeights";

/**
 * Right-side panel of ten priority sliders (GDD §4.1). The user adjusts a
 * slider; the value is written into `sim.sliders` immediately and read by
 * chooseTask on the next tick. No commit button — the colony is always
 * listening.
 *
 * Work sliders show a live head-count ("3 at work") so the player can
 * see the labour split shift as they drag. See sim/jobs/laborWeights.ts
 * for how values map to behaviour.
 */
export class SliderPanel {
  private root: HTMLDivElement;
  private valueLabels: Map<keyof SliderState, HTMLElement> = new Map();
  private inputs: Map<keyof SliderState, HTMLInputElement> = new Map();
  private countLabels: Map<LaborCategory, HTMLElement> = new Map();
  private lastCountTick = -1;
  private unsubscribeVisibility: () => void = () => {};

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
      if ((LABOR_CATEGORIES as ReadonlyArray<string>).includes(key)) {
        const count = document.createElement("span");
        count.style.cssText = "color:#777;margin-left:auto;margin-right:8px;";
        count.title = "Dwarves currently doing this work";
        labelRow.appendChild(count);
        this.countLabels.set(key as LaborCategory, count);
      }
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
        // Write through this.sim, not the constructor argument — refresh()
        // swaps the instance after save/load and the slider must keep
        // steering the *live* world.
        this.sim.sliders[key] = v;
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
      "Sliders bias the colony's autonomous job selection. Higher values pull more dwarves toward that work; near zero switches it off.";
    root.appendChild(note);

    host.appendChild(root);
    this.root = root;
    this.unsubscribeVisibility = attachPanelVisibility("sliders", root);
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

  /** Refresh the per-category head-counts. Cheap: the snapshot is
   * cached per tick and we only repaint when the tick advances. */
  update(): void {
    if (this.sim.tick === this.lastCountTick) return;
    this.lastCountTick = this.sim.tick;
    const { counts } = laborSnapshot(this.sim);
    for (const [cat, el] of this.countLabels) {
      const n = counts[cat];
      el.textContent = this.sim.sliders[cat] <= 0.05 ? "off" : `${n} at work`;
    }
  }

  destroy(): void {
    this.unsubscribeVisibility();
    this.root.remove();
  }
}

function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}
