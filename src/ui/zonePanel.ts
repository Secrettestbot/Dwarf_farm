import { ZoneKind } from "../sim/zones";
import { attachPanelVisibility } from "./displaySettings";

/** Active painting tool. "none" means the canvas pans as usual. */
export type ZoneTool = ZoneKind | "erase" | "none";

const TOOLS: ReadonlyArray<{ id: ZoneTool; label: string; color: string; title: string }> = [
  { id: "dig", label: "⛏ Dig", color: "#e0c080", title: "Drag a rectangle: dwarves will excavate the rock inside it, at their own pace." },
  { id: "forbidden", label: "⊘ Forbid", color: "#e07050", title: "Drag a rectangle: dwarves won't walk or work inside it." },
  { id: "gather", label: "⇲ Gather", color: "#9ad3a3", title: "Drag a rectangle: haulers clear loose items from it first." },
  { id: "erase", label: "✕ Erase", color: "#aaa", title: "Click a zone to remove it." },
];

/** Zone painting toolbar (GDD §4.2). Selecting a tool turns canvas
 * drags into zone rectangles; selecting it again (or Escape) returns
 * to panning. */
export class ZonePanel {
  tool: ZoneTool = "none";
  private root: HTMLDivElement;
  private buttons = new Map<ZoneTool, HTMLButtonElement>();
  private unsubscribeVisibility: () => void;

  constructor(host: HTMLElement) {
    const root = document.createElement("div");
    root.className = "panel";
    root.style.cssText =
      "position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:4px;align-items:center;padding:6px 8px;";
    const label = document.createElement("span");
    label.textContent = "ZONES";
    label.style.cssText = "color:#888;font-size:10px;letter-spacing:2px;margin-right:4px;";
    root.appendChild(label);
    for (const t of TOOLS) {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = t.label;
      b.title = t.title;
      b.style.cssText = `color:${t.color};font-size:11px;padding:4px 8px;`;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => this.setTool(this.tool === t.id ? "none" : t.id));
      root.appendChild(b);
      this.buttons.set(t.id, b);
    }
    host.appendChild(root);
    this.root = root;
    this.unsubscribeVisibility = attachPanelVisibility("zones", root);
  }

  setTool(tool: ZoneTool): void {
    this.tool = tool;
    for (const [id, b] of this.buttons) {
      b.classList.toggle("active", id === tool);
      b.setAttribute("aria-pressed", String(id === tool));
    }
  }

  destroy(): void {
    this.unsubscribeVisibility();
    this.root.remove();
  }
}
