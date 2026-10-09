import { SaveData } from "../save/schema";

// Messages exchanged with the catch-up worker.

export type MainToWorker =
  | { type: "INIT"; save: SaveData; ticksToRun: number }
  | { type: "STOP" };

export type WorkerToMain =
  | { type: "READY" }
  | { type: "PROGRESS"; ticksDone: number; ticksRemaining: number }
  | { type: "DONE"; save: SaveData; ticksDone: number; ticksRequested: number }
  | { type: "ERROR"; message: string };
