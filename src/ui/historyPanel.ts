// History panel — a browseable view of the colony's named artifacts,
// written books, and buried dwarves. Opens as a modal over the
// canvas; pulls live data from sim.artifacts / sim.books / sim.graves
// each time it opens, so the contents are always current.

import { SimWorld } from "../sim/world/simWorld";
import { TICKS_PER_YEAR } from "../sim/time";

export class HistoryPanel {
  private root: HTMLElement;
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.78);display:none;place-items:center;z-index:40;font-family:monospace;color:#cdb88a;";
    this.host.appendChild(wrap);
    this.root = wrap;
    // Click on the dim backdrop closes the panel; clicks inside the
    // body don't propagate.
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) this.close();
    });
  }

  open(sim: SimWorld): void {
    this.root.innerHTML = `
      <div style="background:#1a1410;border:1px solid #4a4030;padding:24px 28px;max-width:680px;width:90vw;max-height:80vh;overflow-y:auto;line-height:1.45;font-size:13px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div>
            <div style="color:#888;font-size:10px;letter-spacing:3px;">⛏ THE COLONY'S HISTORY</div>
            <div style="color:#e0c080;font-size:16px;margin-top:4px;">${countsLine(sim)}</div>
          </div>
          <button id="history-close" class="btn" style="padding:2px 8px;font-size:11px;">×</button>
        </div>
        ${section("Artifacts", artifactsHtml(sim))}
        ${section("Books", booksHtml(sim))}
        ${section("Graves", gravesHtml(sim))}
      </div>
    `;
    this.root.style.display = "grid";
    const close = this.root.querySelector("#history-close") as HTMLButtonElement | null;
    if (close) close.onclick = () => this.close();
  }

  close(): void {
    this.root.style.display = "none";
  }

  isOpen(): boolean {
    return this.root.style.display === "grid";
  }
}

function countsLine(sim: SimWorld): string {
  const a = sim.artifacts.length;
  const b = sim.books.length;
  const g = sim.graves.length;
  const parts: string[] = [];
  parts.push(`${a} artifact${a === 1 ? "" : "s"}`);
  parts.push(`${b} book${b === 1 ? "" : "s"}`);
  parts.push(`${g} grave${g === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function section(title: string, body: string): string {
  return `
    <div style="margin-top:16px;border-top:1px solid #2a2a35;padding-top:10px;">
      <div style="color:#e0c080;font-size:13px;letter-spacing:1px;margin-bottom:6px;">${title}</div>
      ${body}
    </div>
  `;
}

function artifactsHtml(sim: SimWorld): string {
  if (sim.artifacts.length === 0) {
    return `<div style="color:#666;font-size:11px;">No named artifacts yet — a Legendary smith might forge one.</div>`;
  }
  // Newest first.
  const rows = sim.artifacts.slice().reverse().map((a) => {
    const year = Math.floor(a.createdTick / TICKS_PER_YEAR) + 1;
    return `<div style="margin-bottom:4px;">
      <span style="color:#e0c080;">${escapeHtml(a.name)}</span>
      <span style="color:#999;"> — a ${escapeHtml(a.kindLabel)} forged by</span>
      <span style="color:#cdb88a;"> ${escapeHtml(a.makerName)}</span>
      <span style="color:#666;"> (${escapeHtml(a.makerProfession)}, year ${year})</span>
    </div>`;
  });
  return rows.join("");
}

function booksHtml(sim: SimWorld): string {
  if (sim.books.length === 0) {
    return `<div style="color:#666;font-size:11px;">The library shelves are empty so far.</div>`;
  }
  const rows = sim.books.slice().reverse().map((b) => {
    const year = Math.floor(b.writtenAtTick / TICKS_PER_YEAR) + 1;
    return `<div style="margin-bottom:4px;">
      <span style="color:#e0c080;">${escapeHtml(b.title)}</span>
      <span style="color:#999;"> by</span>
      <span style="color:#cdb88a;"> ${escapeHtml(b.authorName)}</span>
      <span style="color:#666;"> (year ${year})</span>
    </div>`;
  });
  return rows.join("");
}

function gravesHtml(sim: SimWorld): string {
  if (sim.graves.length === 0) {
    return `<div style="color:#666;font-size:11px;">No dwarf has been laid to rest in the cemetery yet.</div>`;
  }
  const rows = sim.graves.slice().reverse().map((g) => {
    const year = Math.floor(g.deathTick / TICKS_PER_YEAR) + 1;
    return `<div style="margin-bottom:4px;">
      <span style="color:#e0c080;">${escapeHtml(g.name)}</span>
      <span style="color:#999;">, ${escapeHtml(g.profession)}, aged ${g.ageAtDeath}</span>
      <span style="color:#666;"> — ${escapeHtml(g.cause)} (year ${year})</span>
    </div>`;
  });
  return rows.join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
