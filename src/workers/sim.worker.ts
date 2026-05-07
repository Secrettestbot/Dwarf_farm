import { tick } from "../sim/sim";
import { restore, snapshot } from "../save/snapshot";
import { MainToWorker, WorkerToMain } from "../shared/protocol";

// Catch-up simulation worker. Runs the same `tick()` function the main thread
// uses, just without rendering. Yields every BURST_MS so the host can stay
// responsive and so we can post progress updates.

const BURST_MS = 500;

let cancelled = false;

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  if (msg.type === "STOP") {
    cancelled = true;
    return;
  }
  if (msg.type === "INIT") {
    cancelled = false;
    runCatchup(msg.save, msg.ticksToRun);
  }
};

function post(msg: WorkerToMain): void {
  (self as unknown as Worker).postMessage(msg);
}

async function runCatchup(saveData: import("../save/schema").SaveV1, ticksToRun: number): Promise<void> {
  try {
    const sim = restore(saveData);
    let done = 0;
    post({ type: "READY" });
    while (done < ticksToRun && !cancelled) {
      const burstStart = performance.now();
      while (
        done < ticksToRun &&
        !cancelled &&
        performance.now() - burstStart < BURST_MS
      ) {
        tick(sim);
        done++;
      }
      post({ type: "PROGRESS", ticksDone: done, ticksRemaining: ticksToRun - done });
      // Yield to the event loop so we can receive STOP messages.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (cancelled) {
      // Treat cancellation as "stop here" — return current state as the result.
    }
    const finalSave = snapshot({
      sim,
      slotId: saveData.slotId,
      cameraX: saveData.cameraX,
      cameraY: saveData.cameraY,
      zoomIndex: saveData.zoomIndex,
    });
    post({ type: "DONE", save: finalSave });
  } catch (err) {
    post({ type: "ERROR", message: err instanceof Error ? err.message : String(err) });
  }
}
