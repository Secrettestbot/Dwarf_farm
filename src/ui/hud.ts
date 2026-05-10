import { Clock, SPEED_LEVELS, SpeedLevel, TICKS_PER_HOUR, TICKS_PER_DAY, seasonOf } from "../sim/time";
import { SimWorld } from "../sim/world/simWorld";
import { GameMode } from "../save/schema";
import { isMuted, setMuted } from "../audio/sound";

export interface HudHandlers {
  /** Reads the current fortress name; called on each render so the
   * label updates when the player renames the fortress. */
  fortressName(): string;
  mode: GameMode;
  onSpeedChange(s: SpeedLevel): void;
  onSave(): void;
  /** Returns the world seed at click time so the Share-seed button can
   * read it lazily — the live SimWorld instance can be replaced by
   * save/restore between HUD construction and the click. */
  worldSeed(): number;
  /** Re-open the tutorial overlay. */
  onShowTutorial(): void;
  /** Open the history panel — artifacts, books, graves. */
  onShowHistory(): void;
  /** Open the research panel — research tree status. */
  onShowResearch(): void;
  /** Open the population panel — every living dwarf. */
  onShowPopulation(): void;
  /** Player wants to rename the fortress; the host pops a prompt
   * and, on a non-empty answer, calls `setFortressName`. */
  onRenameFortress(): void;
}

export class Hud {
  private root: HTMLElement;
  private speedButtons: Map<SpeedLevel, HTMLButtonElement> = new Map();
  private clockLabel: HTMLDivElement;
  private dwarfLabel: HTMLDivElement;
  private plannerLabel: HTMLDivElement;
  private stockpileLabel!: HTMLDivElement;
  private nameLabel!: HTMLDivElement;
  private handlers: HudHandlers;

  constructor(host: HTMLElement, handlers: HudHandlers) {
    this.handlers = handlers;
    const top = document.createElement("div");
    top.className = "panel";
    top.style.cssText =
      "position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:6px;min-width:240px;";
    const modeBadge =
      handlers.mode === "saga"
        ? `<span style="color:#ff8a5c;font-size:9px;letter-spacing:2px;">SAGA</span>`
        : `<span style="color:#789;font-size:9px;letter-spacing:2px;">LEGACY</span>`;
    top.innerHTML = `
      <div style="color:#888;font-size:10px;letter-spacing:3px;">⛏ DWARVEN DEEP</div>
      <div id="hud-fortress-name" style="color:#e0c080;font-size:14px;line-height:1.2;cursor:pointer;" title="Click to rename"></div>
    `;
    this.nameLabel = top.querySelector("#hud-fortress-name") as HTMLDivElement;
    this.refreshFortressName(modeBadge);
    this.nameLabel.addEventListener("click", () => {
      handlers.onRenameFortress();
      this.refreshFortressName(modeBadge);
    });

    this.clockLabel = document.createElement("div");
    this.clockLabel.style.fontSize = "11px";
    this.clockLabel.style.color = "#aaa";
    top.appendChild(this.clockLabel);

    this.dwarfLabel = document.createElement("div");
    this.dwarfLabel.style.fontSize = "11px";
    this.dwarfLabel.style.color = "#888";
    top.appendChild(this.dwarfLabel);

    this.plannerLabel = document.createElement("div");
    this.plannerLabel.style.fontSize = "11px";
    this.plannerLabel.style.color = "#888";
    top.appendChild(this.plannerLabel);

    this.stockpileLabel = document.createElement("div");
    this.stockpileLabel.style.fontSize = "11px";
    this.stockpileLabel.style.color = "#888";
    top.appendChild(this.stockpileLabel);

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
    const saveButton = document.createElement("button");
    saveButton.className = "btn";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", () => handlers.onSave());
    tools.appendChild(saveButton);

    // Share-seed button: copy the world seed to the clipboard so the
    // player can pass it along, or paste it back into a New Fortress
    // prompt to relive the same mountain. GDD §13 Phase 4: world seed
    // sharing.
    const seedButton = document.createElement("button");
    seedButton.className = "btn";
    seedButton.textContent = "Share seed";
    seedButton.title = "Copy this world's seed to the clipboard";
    seedButton.addEventListener("click", async () => {
      const seed = String(handlers.worldSeed());
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(seed);
        }
      } catch {
        // Clipboard may be unavailable (insecure context, denied perms).
        // Fall through to the visible-text fallback.
      }
      seedButton.textContent = `seed: ${seed}`;
      window.setTimeout(() => { seedButton.textContent = "Share seed"; }, 1800);
    });
    tools.appendChild(seedButton);

    // Mute toggle — Web Audio is the colony's only sound output, so
    // a single button is enough. Persists in localStorage.
    const muteButton = document.createElement("button");
    muteButton.className = "btn";
    muteButton.title = "Toggle sound";
    const refreshMute = () => {
      muteButton.textContent = isMuted() ? "Sound: off" : "Sound: on";
    };
    refreshMute();
    muteButton.addEventListener("click", () => {
      setMuted(!isMuted());
      refreshMute();
    });
    tools.appendChild(muteButton);

    // History — opens a browseable panel of artifacts / books /
    // graves so the player doesn't have to scroll the chronicle.
    const historyButton = document.createElement("button");
    historyButton.className = "btn";
    historyButton.textContent = "History";
    historyButton.title = "Browse the colony's artifacts, books, and graves";
    historyButton.addEventListener("click", () => handlers.onShowHistory());
    tools.appendChild(historyButton);

    // Research — tier-by-tier view of completed topics and current
    // study. Cross-references books to show which scholar wrote
    // each topic up.
    const researchButton = document.createElement("button");
    researchButton.className = "btn";
    researchButton.textContent = "Research";
    researchButton.title = "Browse the colony's research progress";
    researchButton.addEventListener("click", () => handlers.onShowResearch());
    tools.appendChild(researchButton);

    // Population — every living dwarf, click to inspect + camera-jump.
    const populationButton = document.createElement("button");
    populationButton.className = "btn";
    populationButton.textContent = "Population";
    populationButton.title = "Browse the colony's living dwarves";
    populationButton.addEventListener("click", () => handlers.onShowPopulation());
    tools.appendChild(populationButton);

    // Tutorial replay — opens the new-player overlay any time.
    const helpButton = document.createElement("button");
    helpButton.className = "btn";
    helpButton.textContent = "?";
    helpButton.title = "Show tutorial";
    helpButton.addEventListener("click", () => handlers.onShowTutorial());
    tools.appendChild(helpButton);

    top.appendChild(tools);

    const help = document.createElement("div");
    help.style.cssText = "font-size:10px;color:#666;line-height:1.4;margin-top:6px;";
    help.innerHTML =
      "Drag to pan · scroll to zoom · space pauses<br/>The dwarves work on their own. You only watch.";
    top.appendChild(help);

    host.appendChild(top);
    this.root = top;
  }

  update(clock: Clock, sim: SimWorld): void {
    const tick = clock.tick;
    const day = Math.floor(tick / TICKS_PER_DAY) + 1;
    const hour = Math.floor((tick % TICKS_PER_DAY) / TICKS_PER_HOUR);
    const min = tick % TICKS_PER_HOUR;
    const season = seasonOf(tick);
    const seasonLabel = season.charAt(0).toUpperCase() + season.slice(1);
    this.clockLabel.textContent = `Day ${day} · ${pad(hour)}:${pad(min)} · ${seasonLabel}  (tick ${tick})`;
    const dwarfCount = sim.dwarf.size();
    this.dwarfLabel.textContent = `${dwarfCount} dwarf${dwarfCount === 1 ? "" : "ves"}`;
    const active = sim.planner.activeCount();
    const built = sim.planner.completed;
    this.plannerLabel.textContent = `Plans: ${active} digging · ${built} done`;
    const sp = sim.stockpile;
    // Tooltip strings spell out what each resource is for so the
    // player can see at a glance what produces it and what consumes
    // it. Most "trade good" resources have no in-colony consumer
    // beyond the visiting caravan.
    this.stockpileLabel.innerHTML =
      `<span style="color:#9ad3a3;" title="Eaten by dwarves. Produced by farms; raw food can be cooked into Meals at a Kitchen.">Food ${sp.food}</span> · ` +
      `<span style="color:#8aa9ff;" title="Drunk by dwarves. Produced by Brewery from Food.">Drink ${sp.drink}</span> · ` +
      (sp.meals > 0 ? `<span style="color:#e0c080;" title="Cooked meals — restore more hunger than raw Food. Produced by a Kitchen from Food.">Meals ${sp.meals}</span> · ` : "") +
      `<span title="Smelted into Bars at a Smelter (requires Iron Smelting research).">Ore ${sp.ore}</span> · ` +
      `<span title="Cut into Blocks at a Mason's Workshop (Basic Stonecutting research).">Stone ${sp.stone}</span>` +
      (sp.blocks > 0 ? ` · <span style="color:#b8b8c8;" title="Cut stone — trade good. Future Fortification builds will consume them.">Blocks ${sp.blocks}</span>` : "") +
      (sp.bars > 0 ? ` · <span style="color:#e0a070;" title="Forged into Tools at a Forge (Iron Toolmaking research).">Bars ${sp.bars}</span>` : "") +
      (sp.tools > 0 ? ` · <span style="color:#e0c080;" title="Equipped to drafted soldiers at the year-end draft. Excess can be traded.">Tools ${sp.tools}</span>` : "") +
      (sp.gems > 0 ? ` · <span style="color:#a8d8e0;" title="Cut into Cut Gems at a Jeweller (Gem Cutting research).">Gems ${sp.gems}</span>` : "") +
      (sp.cut_gems > 0 ? ` · <span style="color:#d8a8f0;" title="Cut gems — high-value trade good.">Cut Gems ${sp.cut_gems}</span>` : "") +
      (sp.wood > 0 ? ` · <span style="color:#a87838;" title="Sawn into Planks at a Carpenter's Workshop (Basic Carpentry research).">Wood ${sp.wood}</span>` : "") +
      (sp.planks > 0 ? ` · <span style="color:#c8a070;" title="Sawn timber — trade good.">Planks ${sp.planks}</span>` : "") +
      (sp.pots > 0 ? ` · <span style="color:#c8b090;" title="Fired pottery — trade good. Produced by a Kiln from Dirt (Pottery & Kilns research).">Pots ${sp.pots}</span>` : "") +
      (sp.hide > 0 ? ` · <span style="color:#a07050;" title="Raw hides — dropped by larger hostiles. Tanned into Leather at a Tannery.">Hides ${sp.hide}</span>` : "") +
      (sp.leather > 0 ? ` · <span style="color:#c08858;" title="Tanned leather — trade good. Future armouring will consume it.">Leather ${sp.leather}</span>` : "") +
      (sp.rope > 0 ? ` · <span style="color:#c8b888;" title="Rope fibre — woven into Cloth at a Loom.">Rope ${sp.rope}</span>` : "") +
      (sp.cloth > 0 ? ` · <span style="color:#e0d0b0;" title="Woven cloth — trade good.">Cloth ${sp.cloth}</span>` : "");
    for (const [s, b] of this.speedButtons) {
      b.classList.toggle("active", s === clock.speed);
    }
  }

  destroy(): void {
    this.root.remove();
  }

  private refreshFortressName(modeBadge: string): void {
    this.nameLabel.innerHTML = `${escapeHtml(this.handlers.fortressName())} ${modeBadge}`;
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
