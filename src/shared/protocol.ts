import { SaveV1 } from "../save/schema";

// Messages exchanged with the catch-up worker.

export type MainToWorker =
  | { type: "INIT"; save: SaveV1; ticksToRun: number }
  | { type: "STOP" };

export type WorkerToMain =
  | { type: "READY" }
  | { type: "PROGRESS"; ticksDone: number; ticksRemaining: number }
  | { type: "DONE"; save: SaveV1; ticksDone: number; ticksRequested: number }
  | { type: "ERROR"; message: string };
