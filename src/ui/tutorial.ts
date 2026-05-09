// One-time tutorial overlay shown on the player's first New Fortress.
// Reading material on the GDD's pure-observation premise (the player
// watches; the dwarves act on their own) plus a quick rundown of the
// camera + speed + emergency controls.
//
// Persisted in localStorage as a "seen" flag so a second fortress
// doesn't replay the overlay; the player can manually re-open it from
// the HUD's "?" button.

const STORAGE_KEY = "dwarven-deep:tutorialSeen";

export function tutorialAlreadySeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTutorialSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Best-effort.
  }
}

/** Show the tutorial overlay. Resolves when the player dismisses it. */
export function showTutorial(host: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.78);display:grid;place-items:center;z-index:50;font-family:monospace;color:#e0c080;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "max-width:520px;background:#1a1410;border:1px solid #4a4030;padding:24px 28px;line-height:1.5;font-size:13px;";
    panel.innerHTML = `
      <div style="color:#888;font-size:10px;letter-spacing:3px;margin-bottom:6px;">⛏ DWARVEN DEEP</div>
      <div style="color:#e0c080;font-size:16px;margin-bottom:14px;">A note from the chronicler.</div>
      <p style="color:#cdb88a;margin:0 0 10px;">
        The seven have entered the mountain. They will dig, build, eat,
        sleep, fight, and grow old without your direction. You don't
        give orders. You watch.
      </p>
      <p style="color:#cdb88a;margin:0 0 10px;">
        The colony's <span style="color:#e0c080;">Architect</span> chooses
        what to build and where. The <span style="color:#e0c080;">priority sliders</span>
        on the right shift the colony's emphasis — <em>more farming</em>,
        <em>less mining</em> — but never override autonomy.
      </p>
      <p style="color:#cdb88a;margin:0 0 14px;">
        Three buttons can interrupt that autonomy in a real emergency:
        <span style="color:#e07050;">Alarm</span> (everyone shelter),
        <span style="color:#e07050;">Evacuate</span> (everyone to the
        spawn), and <span style="color:#e07050;">Lockdown</span> (every
        door bars itself shut).
      </p>
      <div style="color:#888;font-size:11px;border-top:1px solid #4a4030;padding-top:10px;line-height:1.7;">
        <div><span style="color:#e0c080;">Drag</span> to pan · <span style="color:#e0c080;">scroll</span> to zoom</div>
        <div><span style="color:#e0c080;">Space</span> pauses · <span style="color:#e0c080;">1 / 2 / 3</span> set speed</div>
        <div><span style="color:#e0c080;">Click a dwarf</span> to inspect them</div>
        <div><span style="color:#e0c080;">Close the tab</span> any time. The mountain remembers.</div>
      </div>
      <button id="tutorial-dismiss" style="margin-top:18px;background:#3a3228;color:#e0c080;border:1px solid #6a5a40;padding:8px 18px;font-family:monospace;cursor:pointer;">Begin watching</button>
    `;
    overlay.appendChild(panel);
    host.appendChild(overlay);
    const button = panel.querySelector("#tutorial-dismiss") as HTMLButtonElement;
    button.focus();
    const dismiss = () => {
      markTutorialSeen();
      overlay.remove();
      resolve();
    };
    button.addEventListener("click", dismiss);
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter") dismiss();
    });
  });
}
