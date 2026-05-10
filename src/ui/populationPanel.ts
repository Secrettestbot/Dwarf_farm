// Population panel — a roster of every living dwarf in the colony.
// Each row shows the dwarf's name, profession, age, current activity,
// and any standout status tags (Mayor, King, ill, in tantrum, sick,
// drafted, etc.). Click a row to open the dwarf inspector pinned to
// that dwarf and pan the camera to them.
//
// Opens as a modal like the History and Research panels; pulls live
// data from the sim each time it opens so the contents are always
// current. The panel deliberately doesn't update while open — a
// large fortress would otherwise re-render dozens of rows per frame.

import { SimWorld } from "../sim/world/simWorld";
import { Camera } from "../render/camera";
import { DwarfInspector } from "./dwarfInspector";
import { EntityId } from "../sim/ecs/world";

export class PopulationPanel {
  private root: HTMLElement;
  private host: HTMLElement;
  private inspector: DwarfInspector;
  private camera: Camera;

  constructor(host: HTMLElement, inspector: DwarfInspector, camera: Camera) {
    this.host = host;
    this.inspector = inspector;
    this.camera = camera;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.78);display:none;place-items:center;z-index:40;font-family:monospace;color:#cdb88a;";
    this.host.appendChild(wrap);
    this.root = wrap;
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) this.close();
    });
  }

  open(sim: SimWorld): void {
    const rows = collectRoster(sim);
    this.root.innerHTML = `
      <div style="background:#1a1410;border:1px solid #4a4030;padding:24px 28px;max-width:780px;width:92vw;max-height:82vh;overflow-y:auto;line-height:1.45;font-size:13px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div>
            <div style="color:#888;font-size:10px;letter-spacing:3px;">⛏ THE COLONY'S POPULATION</div>
            <div style="color:#e0c080;font-size:16px;margin-top:4px;">${rows.length} living dwar${rows.length === 1 ? "f" : "ves"}</div>
          </div>
          <button id="population-close" class="btn" style="padding:2px 8px;font-size:11px;">×</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;margin-top:8px;">
          ${rows.map(rowHtml).join("")}
        </div>
      </div>
    `;
    this.root.style.display = "grid";
    const close = this.root.querySelector("#population-close") as HTMLButtonElement | null;
    if (close) close.onclick = () => this.close();
    // Wire row clicks: open the inspector + pan the camera.
    const rowEls = this.root.querySelectorAll<HTMLElement>("[data-dwarf-id]");
    rowEls.forEach((el) => {
      el.addEventListener("click", () => {
        const id = Number(el.getAttribute("data-dwarf-id"));
        if (!Number.isFinite(id)) return;
        const pos = sim.position.get(id as EntityId);
        if (pos) {
          this.camera.x = pos.x;
          this.camera.y = pos.y;
        }
        this.inspector.open(id as EntityId);
        this.close();
      });
    });
  }

  close(): void {
    this.root.style.display = "none";
  }

  isOpen(): boolean {
    return this.root.style.display === "grid";
  }
}

interface RosterRow {
  id: EntityId;
  name: string;
  profession: string;
  age: number;
  activity: string;
  tags: Array<{ label: string; color: string }>;
}

function collectRoster(sim: SimWorld): RosterRow[] {
  const rows: RosterRow[] = [];
  const ents = sim.dwarf.entities;
  for (let i = 0; i < ents.length; i++) {
    const id = ents[i];
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const age = sim.ageOf(id);
    const job = sim.job.get(id);
    const path = sim.pathing.get(id);
    const walking = path && path.pathIndex < path.path.length - 1;
    const activity = walking ? `walking → ${activityLabel(job?.kind)}` : activityLabel(job?.kind);
    const tags: Array<{ label: string; color: string }> = [];
    if (sim.kingName && sim.kingName === dw.name) tags.push({ label: "King", color: "#e0c080" });
    if (sim.mayorName && sim.mayorName === dw.name) tags.push({ label: "Mayor", color: "#e0c080" });
    if (sim.squad.has(id)) tags.push({ label: "soldier", color: "#c0a060" });
    const disease = sim.disease.get(id);
    if (disease) tags.push({ label: "ill", color: "#e07060" });
    const hp = sim.health.get(id);
    if (hp && hp.hp < hp.maxHp * 0.5) tags.push({ label: "wounded", color: "#e07060" });
    if (sim.tantrum.has(id)) tags.push({ label: "tantrum", color: "#e04040" });
    if (sim.fury.has(id)) tags.push({ label: "fury", color: "#ff8040" });
    if (sim.obsession.has(id)) tags.push({ label: "obsessed", color: "#a8d8e0" });
    if (age < 18) tags.push({ label: "child", color: "#80a0c0" });
    if (age >= 80) tags.push({ label: "elder", color: "#a08070" });
    rows.push({ id, name: dw.name, profession: dw.profession, age, activity, tags });
  }
  // Sort: King first, Mayor next, then by name. Standout statuses
  // float without rearranging the bulk of the colony randomly.
  rows.sort((a, b) => {
    const aRank = rankFor(a, sim);
    const bRank = rankFor(b, sim);
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function rankFor(row: RosterRow, sim: SimWorld): number {
  if (sim.kingName && row.name === sim.kingName) return 0;
  if (sim.mayorName && row.name === sim.mayorName) return 1;
  if (row.tags.some((t) => t.label === "tantrum" || t.label === "fury")) return 2;
  if (row.tags.some((t) => t.label === "ill" || t.label === "wounded")) return 3;
  return 4;
}

function rowHtml(r: RosterRow): string {
  const tagsHtml = r.tags
    .map((t) => `<span style="font-size:10px;padding:1px 5px;border:1px solid ${t.color};color:${t.color};border-radius:2px;">${escapeHtml(t.label)}</span>`)
    .join(" ");
  return `
    <div data-dwarf-id="${r.id}" style="display:flex;justify-content:space-between;gap:12px;padding:6px 8px;border-bottom:1px dashed #2a2a35;cursor:pointer;align-items:center;" onmouseover="this.style.background='#221814';" onmouseout="this.style.background='';">
      <div style="flex:1;min-width:0;">
        <div><span style="color:#e0c080;">${escapeHtml(r.name)}</span> <span style="color:#888;font-size:11px;">— ${escapeHtml(r.profession)}, age ${r.age}</span></div>
        <div style="font-size:11px;color:#aaa;margin-top:2px;">${escapeHtml(r.activity)}</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;max-width:280px;">${tagsHtml}</div>
    </div>
  `;
}

function activityLabel(kind: string | undefined): string {
  if (!kind) return "idle";
  switch (kind) {
    case "mine": return "mining";
    case "sleep": return "sleeping";
    case "socialise": return "talking";
    case "wander": return "wandering";
    case "eat": return "eating";
    case "drink": return "drinking";
    case "tend": return "tending a farm cell";
    case "maintain": return "maintaining a room";
    case "shelter": return "sheltering";
    case "haul": return "hauling";
    case "craft": return "crafting at a workshop";
    case "engage": return "fighting";
    case "research": return "studying";
    case "pump": return "pumping water";
    case "visit_grave": return "at a grave";
    case "treat": return "treating a patient";
    case "trade": return "negotiating with a caravan";
    default: return kind;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
