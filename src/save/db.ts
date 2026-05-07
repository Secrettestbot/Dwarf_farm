import { SaveV1, SlotSummary } from "./schema";

const DB_NAME = "dwarven-deep";
const DB_VERSION = 1;
const STORE = "saves";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "slotId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveGame(save: SaveV1): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(save);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function loadGame(slotId: string): Promise<SaveV1 | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(slotId);
    req.onsuccess = () => resolve((req.result as SaveV1) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSave(slotId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(slotId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSaves(): Promise<SaveV1[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as SaveV1[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

/** Return one summary per occupied slot. Empty slots are omitted. */
export async function listSlotSummaries(): Promise<SlotSummary[]> {
  const all = await listSaves();
  return all.map((s) => ({
    slotId: s.slotId,
    fortressName: s.fortressName ?? "Unnamed Fortress",
    mode: s.mode ?? "legacy",
    population: s.dwarves.length,
    tick: s.tick,
    realTimestampMs: s.realTimestampMs,
  }));
}
