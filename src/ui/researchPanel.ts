// Research panel — a tier-by-tier view of every topic in the
// research tree. Shows what's complete, what's currently being
// studied (with progress), what's unlocked, and what's still gated
// on prereqs. Cross-references sim.books so the player can see
// which scholar wrote the book on each completed topic.
//
// Player choice: every available topic carries two buttons —
// "Study next" queues it to follow the current topic, "Study now"
// switches to it immediately (progress on the topic set aside is
// banked, not lost; see research.ts). The panel re-renders after
// each click so the queued / current markers update in place.

import { SimWorld } from "../sim/world/simWorld";
import {
  ALL_TOPICS, ResearchTopic, ResearchTier, TOPICS_BY_ID, hasMaterials, RESEARCH_COST_SCALE,
  queueTopic, switchTopic, topicProgressFraction,
} from "../sim/research";
import { TICKS_PER_YEAR } from "../sim/time";

export class ResearchPanel {
  private root: HTMLElement;
  private host: HTMLElement;
  /** Sim the panel was last opened on — the click handler mutates its
   * research state and re-renders against it. */
  private sim: SimWorld | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.78);display:none;place-items:center;z-index:40;font-family:monospace;color:#cdb88a;";
    this.host.appendChild(wrap);
    this.root = wrap;
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) {
        this.close();
        return;
      }
      const btn = (e.target as HTMLElement | null)?.closest?.("button[data-research-action]") as HTMLButtonElement | null;
      if (!btn || !this.sim) return;
      const id = btn.dataset.topic ?? "";
      const sim = this.sim;
      const ctx = { cumulative: sim.cumulative, discovered: sim.discoveries };
      if (btn.dataset.researchAction === "queue") queueTopic(sim.research, id, ctx);
      else if (btn.dataset.researchAction === "switch") switchTopic(sim.research, id, ctx);
      this.open(sim);
    });
  }

  open(sim: SimWorld): void {
    this.sim = sim;
    // Keep the scroll position across re-renders (button clicks).
    const prevScroll = (this.root.firstElementChild as HTMLElement | null)?.scrollTop ?? 0;
    const completed = new Set(sim.research.completed);
    const current = sim.research.current;
    const currentTopic = current ? TOPICS_BY_ID[current] : null;
    const progressPct = currentTopic
      ? Math.round(topicProgressFraction(sim.research, currentTopic) * 100)
      : 0;
    const queuedTopic = sim.research.queued ? TOPICS_BY_ID[sim.research.queued] : null;
    const tiers: ResearchTier[] = [1, 2, 3, 4, 5, 6];

    const headline = currentTopic
      ? `Studying <span style="color:#e0c080;">${currentTopic.name}</span> · ${progressPct}%`
      : completed.size === ALL_TOPICS.length
        ? `<span style="color:#e0c080;">All research complete.</span>`
        : `No active topic — researchers are idle.`;
    const queuedLine = queuedTopic
      ? `<div style="color:#9fc0e0;font-size:12px;margin-top:2px;">Next up: ${escapeHtml(queuedTopic.name)}</div>`
      : `<div style="color:#777;font-size:11px;margin-top:2px;">Next up: cheapest available topic (pick one with "Study next")</div>`;

    this.root.innerHTML = `
      <div style="background:#1a1410;border:1px solid #4a4030;padding:24px 28px;max-width:780px;width:92vw;max-height:82vh;overflow-y:auto;line-height:1.45;font-size:13px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div>
            <div style="color:#888;font-size:10px;letter-spacing:3px;">⛏ THE COLONY'S RESEARCH</div>
            <div style="color:#e0c080;font-size:16px;margin-top:4px;">${completed.size} / ${ALL_TOPICS.length} topics complete</div>
            <div style="color:#bbb;font-size:12px;margin-top:4px;">${headline}</div>
            ${queuedLine}
          </div>
          <button id="research-close" class="btn" style="padding:2px 8px;font-size:11px;">×</button>
        </div>
        ${tiers.map((t) => tierSection(t, sim, completed, current)).join("")}
      </div>
    `;
    this.root.style.display = "grid";
    const scroller = this.root.firstElementChild as HTMLElement | null;
    if (scroller) scroller.scrollTop = prevScroll;
    const close = this.root.querySelector("#research-close") as HTMLButtonElement | null;
    if (close) close.onclick = () => this.close();
  }

  close(): void {
    this.root.style.display = "none";
  }

  isOpen(): boolean {
    return this.root.style.display === "grid";
  }
}

function tierSection(tier: ResearchTier, sim: SimWorld, completed: Set<string>, current: string | null): string {
  const topics = ALL_TOPICS.filter((t) => t.tier === tier);
  const doneInTier = topics.filter((t) => completed.has(t.id)).length;
  const heading = `Tier ${tier} <span style="color:#888;">— ${doneInTier} / ${topics.length}</span>`;
  const rows = topics.map((t) => topicRow(t, sim, completed, current)).join("");
  return `
    <div style="margin-top:16px;border-top:1px solid #2a2a35;padding-top:10px;">
      <div style="color:#e0c080;font-size:13px;letter-spacing:1px;margin-bottom:6px;">${heading}</div>
      ${rows}
    </div>
  `;
}

function topicRow(t: ResearchTopic, sim: SimWorld, completed: Set<string>, current: string | null): string {
  const isDone = completed.has(t.id);
  const isCurrent = current === t.id;
  const isQueued = sim.research.queued === t.id;
  const prereqsMet = t.prereqs.every((p) => completed.has(p));
  const materialsMet = hasMaterials(t, { cumulative: sim.cumulative, discovered: sim.discoveries });
  const available = !isDone && prereqsMet && materialsMet;
  const pct = Math.round(topicProgressFraction(sim.research, t) * 100);
  const banked = !isCurrent && !isDone && pct > 0;
  const status = isDone
    ? `<span style="color:#7fc08c;">✓ complete</span>`
    : isCurrent
      ? `<span style="color:#e0c080;">studying ${pct}%</span>`
      : isQueued
        ? `<span style="color:#9fc0e0;">queued next${banked ? ` · ${pct}%` : ""}</span>`
        : available
          ? `<span style="color:#aaa;">available${banked ? ` · ${pct}% banked` : ""}</span>`
          : `<span style="color:#666;">locked</span>`;
  // Book + author for completed topics — cross-reference sim.books.
  const book = isDone ? sim.books.find((b) => b.topicId === t.id) : undefined;
  const bookLine = book
    ? `<div style="font-size:10px;color:#888;margin-top:2px;">"${escapeHtml(book.title)}" — ${escapeHtml(book.authorName)}, year ${Math.max(1, Math.floor(book.writtenAtTick / TICKS_PER_YEAR))}</div>`
    : "";
  const effectLine = `<div style="font-size:10px;color:${isDone ? "#8a9a7a" : "#998a6a"};margin-top:2px;">${escapeHtml(t.effect)}</div>`;
  const prereqLine = !prereqsMet && t.prereqs.length > 0
    ? `<div style="font-size:10px;color:#666;margin-top:2px;">requires: ${t.prereqs.map((p) => TOPICS_BY_ID[p]?.name ?? p).join(", ")}</div>`
    : "";
  // Material gate hint for locked topics whose prereqs are met but
  // the colony hasn't actually mined / discovered the material yet.
  const materialLine = !isDone && prereqsMet && !materialsMet && t.materials
    ? `<div style="font-size:10px;color:#a8d0c0;margin-top:2px;">needs: ${t.materials.map((m) => m.describe).join(", ")}</div>`
    : "";
  // Progress bar for the current topic (or banked progress).
  const progressBar = isCurrent || banked
    ? `<div style="height:3px;background:#2a2a35;margin-top:4px;">
         <div style="height:3px;width:${pct}%;background:${isCurrent ? "#e0c080" : "#7a6a40"};"></div>
       </div>`
    : "";
  // Player-choice buttons on available, not-current topics.
  const btnStyle = "padding:1px 6px;font-size:10px;margin-top:3px;margin-left:4px;";
  const buttons = available && !isCurrent
    ? `<div>
         <button class="btn" data-research-action="queue" data-topic="${t.id}" style="${btnStyle}" title="${isQueued ? "Un-queue this topic" : "Study this topic when the current one finishes"}">${isQueued ? "Unqueue" : "Study next"}</button>
         ${current ? `<button class="btn" data-research-action="switch" data-topic="${t.id}" style="${btnStyle}" title="Switch now — progress on the current topic is kept">Study now</button>` : ""}
       </div>`
    : "";
  const nameColor = isDone ? "#cdb88a" : isCurrent ? "#e0c080" : isQueued ? "#9fc0e0" : available ? "#bbb" : "#666";
  return `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed #2a2a35;">
      <div style="flex:1;min-width:0;">
        <div style="color:${nameColor};">${escapeHtml(t.name)}</div>
        ${effectLine}
        ${bookLine}
        ${prereqLine}
        ${materialLine}
        ${progressBar}
      </div>
      <div style="font-size:11px;text-align:right;flex-shrink:0;">${status}<div style="color:#666;font-size:10px;">${t.cost * RESEARCH_COST_SCALE} ticks</div>${buttons}</div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
