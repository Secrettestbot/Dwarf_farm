// Dwarf inspector — click any dwarf in the world to see who they are.
// Shows the GDD §6 character sheet condensed: name, profession, age,
// traits with descriptions, top skills with tier labels, current activity,
// and the two needs we model (sleep, social) as little bars.
//
// Updates in real-time while open so you can watch a dwarf's needs decay
// or their progress on the current job tick.

import { SimWorld } from "../sim/world/simWorld";
import { EntityId } from "../sim/ecs/world";
import { TRAITS_BY_ID } from "../sim/dwarves/traits";
import { SKILLS_BY_ID, skillTierLabel, SkillId } from "../sim/dwarves/skills";
import { progressInLevel } from "../sim/dwarves/skillProgress";

const ACTIVITY_LABEL: Record<string, string> = {
  mine: "mining",
  sleep: "sleeping",
  socialise: "talking with another dwarf",
  wander: "wandering",
};

export class DwarfInspector {
  private root: HTMLElement;
  private host: HTMLElement;
  private targetId: EntityId | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    const wrap = document.createElement("div");
    wrap.className = "panel";
    wrap.style.cssText =
      "position:absolute;top:8px;right:8px;width:300px;max-width:42vw;padding:10px 12px;font-size:12px;color:#ccc;display:none;";
    this.host.appendChild(wrap);
    this.root = wrap;
  }

  open(id: EntityId): void {
    this.targetId = id;
    this.root.style.display = "block";
  }

  close(): void {
    this.targetId = null;
    this.root.style.display = "none";
  }

  isOpen(): boolean {
    return this.targetId !== null;
  }

  /**
   * Re-render with current sim state. Cheap enough to call every frame
   * because the panel is small. If the dwarf is gone (e.g. died), close.
   */
  update(sim: SimWorld): void {
    if (this.targetId === null) return;
    const dw = sim.dwarf.get(this.targetId);
    const pos = sim.position.get(this.targetId);
    if (!dw || !pos) {
      this.close();
      return;
    }
    const age = sim.ageOf(this.targetId);
    const job = sim.job.get(this.targetId);
    const path = sim.pathing.get(this.targetId);
    const needs = sim.needs.get(this.targetId);
    const lifeStage = age < 5 ? "child" : age < 18 ? "youth" : age < 80 ? "adult" : "elder";
    const partner = dw.partnerId !== null && sim.ecs.isAlive(dw.partnerId) ? sim.dwarf.get(dw.partnerId) : null;

    const traits = dw.traitIds
      .map((id) => TRAITS_BY_ID[id])
      .filter((t): t is NonNullable<typeof t> => !!t);

    const traitsHtml = traits
      .map(
        (t) =>
          `<span title="${escapeAttr(t.description)}" style="display:inline-block;background:#1c1c24;border:1px solid #2a2a35;padding:1px 6px;border-radius:8px;margin:1px 3px 1px 0;font-size:10px;color:${categoryColor(t.category)};">${escapeHtml(t.name)}</span>`,
      )
      .join("");

    // Top 5 skills by level. Each row shows a small XP progress bar to the
    // next level so the player can see who's about to advance.
    const skillEntries = Object.entries(dw.skills) as Array<[SkillId, number]>;
    skillEntries.sort((a, b) => b[1] - a[1]);
    const topSkills = skillEntries
      .slice(0, 5)
      .map(([id, lvl]) => {
        const s = SKILLS_BY_ID[id];
        const xp = dw.skillXp[id] ?? 0;
        const p = progressInLevel(xp);
        const pct = p.xpForNext === 0 ? 100 : Math.min(100, Math.floor((p.xpInLevel / p.xpForNext) * 100));
        return `
          <div style="font-size:11px;color:#aaa;margin-top:3px;">
            <div style="display:flex;justify-content:space-between;">
              <span>${escapeHtml(s.name)}</span>
              <span style="color:#888;">${skillTierLabel(lvl)} (${lvl})</span>
            </div>
            <div style="background:#1c1c24;height:3px;border-radius:2px;overflow:hidden;margin-top:2px;">
              <div style="height:100%;width:${pct}%;background:#7a8aa6;"></div>
            </div>
          </div>`;
      })
      .join("");

    const activity = job
      ? `${ACTIVITY_LABEL[job.kind] ?? job.kind}${path && path.pathIndex < path.path.length - 1 ? " (en route)" : ""}`
      : "idle";

    const needsHtml = needs
      ? `
        ${bar("Sleep", needs.sleep)}
        ${bar("Social", needs.social)}
      `
      : "";

    this.root.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-start;">
        <div style="width:40px;height:40px;background:${portraitColor(dw.name)};border:1px solid #2a2a35;border-radius:4px;flex:0 0 40px;display:grid;place-items:center;color:#0a0a0e;font-weight:bold;font-size:18px;">
          ${escapeHtml(dw.name.slice(0, 1))}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="color:#e0c080;font-size:14px;line-height:1.2;">${escapeHtml(dw.name)}</div>
          <div style="font-size:11px;color:#888;">${escapeHtml(dw.profession)} · ${lifeStage} · age ${age} · @ ${pos.x},${pos.y}</div>
        </div>
        <button id="inspector-close" class="btn" style="padding:2px 8px;font-size:11px;">×</button>
      </div>
      ${partner ? `<div style="margin-top:6px;font-size:11px;color:#888;">Partnered with <span style="color:#e0c080;">${escapeHtml(partner.name)}</span></div>` : ""}
      <div style="margin-top:8px;font-size:11px;color:#888;">Activity: <span style="color:#bbb;">${escapeHtml(activity)}</span></div>
      ${needsHtml}
      <div style="margin-top:8px;">${traitsHtml || '<span style="color:#666;">no traits</span>'}</div>
      <div style="margin-top:8px;border-top:1px solid #2a2a35;padding-top:6px;">${topSkills}</div>
    `;
    const closeBtn = this.root.querySelector("#inspector-close") as HTMLButtonElement | null;
    if (closeBtn) closeBtn.onclick = () => this.close();
  }
}

function bar(label: string, value: number): string {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct < 30 ? "#ff7060" : pct < 60 ? "#e0c080" : "#9ad3a3";
  return `
    <div style="margin-top:5px;font-size:10px;color:#888;display:flex;justify-content:space-between;">
      <span>${label}</span><span>${Math.round(pct)}</span>
    </div>
    <div style="background:#1c1c24;height:5px;border-radius:3px;overflow:hidden;">
      <div style="height:100%;width:${pct}%;background:${tone};"></div>
    </div>
  `;
}

function categoryColor(c: string): string {
  switch (c) {
    case "work": return "#e3c688";
    case "social": return "#9ad3a3";
    case "physical": return "#c19fd5";
    case "special": return "#e07f8f";
    default: return "#aaa";
  }
}

function portraitColor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (h * 33) ^ name.charCodeAt(i);
  const r = 0x60 + (h & 0x7f);
  const g = 0x40 + ((h >> 7) & 0x7f);
  const b = 0x40 + ((h >> 14) & 0x5f);
  return `rgb(${r & 0xff},${g & 0xff},${b & 0xff})`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
function escapeAttr(s: string): string { return escapeHtml(s); }
