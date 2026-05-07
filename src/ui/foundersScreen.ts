import { Founder, generateFounder, generateFounders } from "../sim/dwarves/founders";
import { Rng } from "../sim/rng";
import { suggestSwaps, TraitDef } from "../sim/dwarves/traits";
import { skillTierLabel, SKILLS_BY_ID, SkillId } from "../sim/dwarves/skills";

export interface FoundersResult {
  founders: Founder[];
  fortressName: string;
}

/**
 * "Meet Your Founders" screen per GDD §6.6. The screen is offered, never
 * forced — Begin returns the procgen result as-is. Per-dwarf actions: rename,
 * swap any trait (from 3 random alternates), or re-roll the dwarf entirely.
 * The Re-roll All button reseeds the entire group.
 */
export async function showFoundersScreen(host: HTMLElement, seed: number): Promise<FoundersResult> {
  return new Promise((resolve) => {
    // A founders-specific RNG fork keeps re-rolls independent of the world's
    // own RNG streams (so re-rolling the founders does not perturb worldgen).
    const rootRng = Rng.fromSeed(seed).fork("founders");
    let founders: Founder[] = generateFounders(rootRng.fork("initial"));
    let rerollEpoch = 0;

    host.innerHTML = "";
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;inset:0;background:#0a0a0e;color:#ddd;display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto;";
    const card = document.createElement("div");
    card.style.cssText = "max-width:760px;width:100%;";
    root.appendChild(card);
    host.appendChild(root);

    function render() {
      card.innerHTML = `
        <h2 style="color:#e0c080;margin:0 0 4px;text-align:center;">The Founding Seven</h2>
        <div style="font-size:12px;color:#777;text-align:center;margin-bottom:18px;">
          Seven dwarves stand at the entrance to the mountain. Adjust them — or don't. The mountain is patient.
        </div>
        <div style="display:flex;gap:8px;justify-content:center;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
          <span style="font-size:11px;color:#666;">Fortress name</span>
          <input id="fortName" class="btn" style="width:240px;text-align:center;" value="${escapeAttr(autoFortressName(founders))}"/>
          <button id="rollName" class="btn" style="font-size:11px;" title="Suggest a name">↻</button>
        </div>
        <div id="founders-list" style="display:flex;flex-direction:column;gap:8px;"></div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap;">
          <button id="reroll-all" class="btn">Re-roll All</button>
          <button id="begin" class="btn" style="background:#3a2818;color:#f4d8a8;border-color:#5a4028;">Begin Fortress →</button>
        </div>
      `;

      const list = card.querySelector("#founders-list") as HTMLElement;
      founders.forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "panel";
        row.style.cssText = "padding:12px 14px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;";

        const portrait = document.createElement("div");
        portrait.style.cssText = `
          width:48px;height:48px;flex:0 0 48px;background:${dwarfPortraitColor(f, i + rerollEpoch * 31)};
          border:1px solid #2a2a35;border-radius:4px;display:grid;place-items:center;color:#0a0a0e;font-weight:bold;font-size:18px;
        `;
        portrait.textContent = f.name.slice(0, 1);
        row.appendChild(portrait);

        const meta = document.createElement("div");
        meta.style.cssText = "flex:1;min-width:240px;";
        const traitsHtml = f.traits
          .map((t, traitIdx) =>
            `<span class="trait-chip" data-i="${i}" data-trait="${traitIdx}" title="${escapeAttr(t.description)} (click to swap)" style="display:inline-block;cursor:pointer;background:#1c1c24;border:1px solid #2a2a35;padding:2px 8px;border-radius:10px;margin:2px 4px 2px 0;font-size:11px;color:${categoryColor(t)};">${escapeHtml(t.name)}</span>`,
          )
          .join("");
        meta.innerHTML = `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input class="btn dwarf-name" data-i="${i}" value="${escapeAttr(f.name)}" style="font-size:14px;color:#e0c080;background:#0e0e12;min-width:200px;flex:1;"/>
            <span style="font-size:11px;color:#888;">${escapeHtml(f.profession)} · age ${f.age}</span>
          </div>
          <div style="margin-top:6px;">${traitsHtml}</div>
          <div style="margin-top:4px;font-size:11px;color:#888;">${topSkillsLabel(f)}</div>
        `;
        row.appendChild(meta);

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        const reroll = document.createElement("button");
        reroll.className = "btn";
        reroll.style.fontSize = "11px";
        reroll.textContent = "Re-roll";
        reroll.addEventListener("click", () => {
          const used = new Set(founders.filter((_, k) => k !== i).map((g) => g.name.split(" ")[0]));
          founders[i] = generateFounder(rootRng.fork(`reroll_${rerollEpoch}_${i}`), used);
          rerollEpoch++;
          render();
        });
        actions.appendChild(reroll);
        row.appendChild(actions);

        list.appendChild(row);
      });

      list.querySelectorAll<HTMLInputElement>(".dwarf-name").forEach((el) => {
        el.addEventListener("input", (e) => {
          const target = e.target as HTMLInputElement;
          const i = Number(target.dataset.i);
          founders[i] = { ...founders[i], name: target.value };
        });
      });

      list.querySelectorAll<HTMLElement>(".trait-chip").forEach((el) => {
        el.addEventListener("click", () => {
          const i = Number(el.dataset.i);
          const traitIdx = Number(el.dataset.trait);
          openTraitSwap(rootRng.fork(`swap_${rerollEpoch}_${i}_${traitIdx}`), i, traitIdx);
        });
      });

      (card.querySelector("#reroll-all") as HTMLButtonElement).addEventListener("click", () => {
        rerollEpoch++;
        founders = generateFounders(rootRng.fork(`all_${rerollEpoch}`));
        render();
      });
      (card.querySelector("#rollName") as HTMLButtonElement).addEventListener("click", () => {
        const inp = card.querySelector("#fortName") as HTMLInputElement;
        inp.value = autoFortressName(founders, rootRng.fork(`fname_${rerollEpoch++}`));
      });

      (card.querySelector("#begin") as HTMLButtonElement).addEventListener("click", () => {
        const fortressName = (card.querySelector("#fortName") as HTMLInputElement).value.trim() || autoFortressName(founders);
        root.remove();
        resolve({ founders, fortressName });
      });
    }

    function openTraitSwap(rng: Rng, dwarfIdx: number, traitIdx: number) {
      const f = founders[dwarfIdx];
      const current = f.traits[traitIdx];
      const others = f.traits.filter((_, k) => k !== traitIdx);
      const candidates = suggestSwaps(rng, current, others);

      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.7);display:grid;place-items:center;z-index:50;";
      const popup = document.createElement("div");
      popup.className = "panel";
      popup.style.cssText = "padding:18px;max-width:440px;width:90%;";
      popup.innerHTML = `
        <div style="font-size:14px;color:#e0c080;margin-bottom:6px;">Swap a trait on ${escapeHtml(f.name)}</div>
        <div style="font-size:11px;color:#888;margin-bottom:10px;">Currently: <b style="color:#bbb;">${escapeHtml(current.name)}</b> — ${escapeHtml(current.description)}</div>
        <div id="swap-options" style="display:flex;flex-direction:column;gap:6px;"></div>
        <div style="margin-top:12px;text-align:right;">
          <button id="swap-cancel" class="btn">Cancel</button>
        </div>
      `;
      const optHost = popup.querySelector("#swap-options") as HTMLElement;
      candidates.forEach((c) => {
        const b = document.createElement("button");
        b.className = "btn";
        b.style.cssText = "text-align:left;padding:8px 10px;";
        b.innerHTML = `<b style="color:${categoryColor(c)};">${escapeHtml(c.name)}</b> <span style="color:#777;font-size:11px;">(${c.category} · ${c.rarity})</span><br/><span style="font-size:11px;color:#aaa;">${escapeHtml(c.description)}</span>`;
        b.addEventListener("click", () => {
          founders[dwarfIdx].traits[traitIdx] = c;
          overlay.remove();
          render();
        });
        optHost.appendChild(b);
      });
      (popup.querySelector("#swap-cancel") as HTMLButtonElement).addEventListener("click", () => overlay.remove());
      overlay.appendChild(popup);
      document.body.appendChild(overlay);
    }

    render();
  });
}

function categoryColor(t: TraitDef): string {
  switch (t.category) {
    case "work": return "#e3c688";
    case "social": return "#9ad3a3";
    case "physical": return "#c19fd5";
    case "special": return "#e07f8f";
  }
}

function topSkillsLabel(f: Founder): string {
  const entries = Object.entries(f.skills) as Array<[SkillId, number]>;
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 3);
  return top.map(([id, lvl]) => `${SKILLS_BY_ID[id].name} ${skillTierLabel(lvl)} (${lvl})`).join(" · ");
}

function autoFortressName(founders: Founder[], rng?: Rng): string {
  // Borrow surname elements from the first founder for a plausible name.
  const surname = founders[0]?.name.split(" ")[1] ?? "Hold";
  const root = surname.replace(/(back|foot|beard|fist|braids|kin|borne|heart|shanks|helm|vein|axe|delver|warden|knuckle|hand|shaper|runner|ward|song)$/i, "");
  const suffixes = ["Hold", "Deep", "Halls", "Vault", "Mountain", "Hearth", "Stone", "Caverns"];
  const idx = rng ? Math.floor(rng.nextFloat() * suffixes.length) : 0;
  return `${root}${suffixes[idx]}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
function escapeAttr(s: string): string { return escapeHtml(s); }

/** Deterministic-ish portrait color from a dwarf's name + an epoch nonce. */
function dwarfPortraitColor(f: Founder, salt: number): string {
  let h = 5381 ^ salt;
  for (let i = 0; i < f.name.length; i++) h = (h * 33) ^ f.name.charCodeAt(i);
  const r = 0x60 + (h & 0x7f);
  const g = 0x40 + ((h >> 7) & 0x7f);
  const b = 0x40 + ((h >> 14) & 0x5f);
  return `rgb(${r & 0xff},${g & 0xff},${b & 0xff})`;
}
