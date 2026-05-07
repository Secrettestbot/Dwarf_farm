import { TICKS_PER_DAY, TICKS_PER_HOUR } from "../sim/time";

export interface ReturnScreenHandle {
  setProgress(done: number, total: number): void;
  setStatus(line: string): void;
  close(): void;
}

export function showReturnScreen(host: HTMLElement, elapsedMs: number, ticksToRun: number): ReturnScreenHandle {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;background:#0a0a0e;color:#ddd;display:flex;align-items:center;justify-content:center;font-family:inherit;z-index:100;";
  const card = document.createElement("div");
  card.style.cssText = "max-width:560px;width:90%;text-align:center;";
  const sec = Math.floor(elapsedMs / 1000);
  const realLabel = formatRealElapsed(sec);
  const igDays = Math.floor(ticksToRun / TICKS_PER_DAY);
  const igHours = Math.floor((ticksToRun % TICKS_PER_DAY) / TICKS_PER_HOUR);
  const igLabel = igDays > 0 ? `${igDays} day${igDays === 1 ? "" : "s"}, ${igHours}h` : `${igHours}h`;

  card.innerHTML = `
    <div style="font-size:14px;letter-spacing:6px;color:#888;margin-bottom:8px;">⛏  RETURNING</div>
    <h1 style="font-size:24px;margin:0 0 12px;color:#e0c080;">You were away for ${realLabel}.</h1>
    <div style="color:#aaa;margin-bottom:24px;">It has been <strong style="color:#e0c080;">${igLabel}</strong> in the mountain. Replaying events…</div>
    <div id="rs-status" style="color:#888;font-size:12px;margin-bottom:12px;">Restoring world from save…</div>
    <div style="background:#222;border:1px solid #444;height:14px;border-radius:2px;overflow:hidden;">
      <div id="rs-bar" style="background:#e0c080;height:100%;width:0%;transition:width 80ms linear;"></div>
    </div>
    <div id="rs-progress" style="margin-top:8px;font-size:11px;color:#666;"></div>
  `;
  root.appendChild(card);
  host.appendChild(root);

  const bar = card.querySelector("#rs-bar") as HTMLDivElement;
  const status = card.querySelector("#rs-status") as HTMLDivElement;
  const prog = card.querySelector("#rs-progress") as HTMLDivElement;

  return {
    setProgress(done, total) {
      const pct = total === 0 ? 100 : Math.min(100, Math.floor((done / total) * 100));
      bar.style.width = `${pct}%`;
      prog.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} ticks  (${pct}%)`;
    },
    setStatus(line) {
      status.textContent = line;
    },
    close() {
      root.remove();
    },
  };
}

function formatRealElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}
