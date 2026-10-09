// In-game modal dialogs. Replace window.alert / confirm / prompt so
// the game keeps its own look, works in fullscreen, and never blocks
// the main thread.

export interface DialogButton<T> {
  label: string;
  value: T;
  /** Accent the button as the primary or destructive action. */
  tone?: "primary" | "danger";
}

export interface DialogOptions<T> {
  title: string;
  /** Plain text, or an element for richer bodies. */
  body?: string | HTMLElement;
  buttons: DialogButton<T>[];
  /** Value resolved when the player presses Escape or clicks the backdrop. */
  dismissValue: T;
  /** Optional single-line text input shown under the body. */
  input?: { value: string; placeholder?: string; maxLength?: number };
}

export interface DialogResult<T> {
  value: T;
  /** Text field contents, when `input` was supplied. */
  text: string;
}

export function showDialog<T>(host: HTMLElement, opts: DialogOptions<T>): Promise<DialogResult<T>> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.72);display:grid;place-items:center;z-index:60;font-family:monospace;";
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", opts.title);
    panel.style.cssText =
      "background:#1a1410;border:1px solid #4a4030;padding:20px 24px;max-width:min(480px, calc(100vw - 32px));width:100%;color:#cdb88a;font-size:13px;line-height:1.5;max-height:80vh;overflow:auto;";

    const title = document.createElement("div");
    title.style.cssText = "color:#e0c080;font-size:15px;margin-bottom:10px;";
    title.textContent = opts.title;
    panel.appendChild(title);

    if (opts.body !== undefined) {
      if (typeof opts.body === "string") {
        const p = document.createElement("div");
        p.style.cssText = "white-space:pre-wrap;margin-bottom:12px;";
        p.textContent = opts.body;
        panel.appendChild(p);
      } else {
        panel.appendChild(opts.body);
      }
    }

    let input: HTMLInputElement | null = null;
    if (opts.input) {
      input = document.createElement("input");
      input.type = "text";
      input.className = "btn";
      input.value = opts.input.value;
      if (opts.input.placeholder) input.placeholder = opts.input.placeholder;
      if (opts.input.maxLength) input.maxLength = opts.input.maxLength;
      input.style.cssText = "width:100%;box-sizing:border-box;margin-bottom:12px;text-align:left;";
      panel.appendChild(input);
    }

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
    let primary: HTMLButtonElement | null = null;
    for (const b of opts.buttons) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = b.label;
      if (b.tone === "primary") {
        btn.style.color = "#e0c080";
        btn.style.borderColor = "#6a5a40";
        primary = btn;
      } else if (b.tone === "danger") {
        btn.style.color = "#e07050";
      }
      btn.addEventListener("click", () => finish(b.value));
      row.appendChild(btn);
    }
    panel.appendChild(row);
    overlay.appendChild(panel);
    host.appendChild(overlay);

    const finish = (value: T) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve({ value, text: input ? input.value : "" });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(opts.dismissValue);
      } else if (e.key === "Enter" && primary) {
        e.preventDefault();
        e.stopPropagation();
        primary.click();
      } else {
        // Keep game hotkeys (space, WASD…) from firing behind the modal.
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(opts.dismissValue);
    });
    (input ?? primary ?? row.querySelector("button"))?.focus();
  });
}

export async function showMessage(host: HTMLElement, title: string, body: string): Promise<void> {
  await showDialog(host, { title, body, buttons: [{ label: "OK", value: true, tone: "primary" }], dismissValue: true });
}

export async function showConfirm(
  host: HTMLElement,
  title: string,
  body: string,
  confirmLabel = "Confirm",
  danger = false,
): Promise<boolean> {
  const r = await showDialog(host, {
    title,
    body,
    buttons: [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, tone: danger ? "danger" : "primary" },
    ],
    dismissValue: false,
  });
  return r.value;
}

export async function showPrompt(
  host: HTMLElement,
  title: string,
  initial: string,
  maxLength = 60,
): Promise<string | null> {
  const r = await showDialog(host, {
    title,
    input: { value: initial, maxLength },
    buttons: [
      { label: "Cancel", value: false },
      { label: "OK", value: true, tone: "primary" },
    ],
    dismissValue: false,
  });
  return r.value ? r.text : null;
}
