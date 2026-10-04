import { SaveData, SlotSummary } from "./schema";

const DB_NAME = "dwarven-deep";
// v2 adds the "checkpoints" store (Legacy-mode restore points).
const DB_VERSION = 2;
const STORE = "saves";
const CHECKPOINTS = "checkpoints";
/** Restore points kept per slot; older ones are pruned. */
export const MAX_CHECKPOINTS_PER_SLOT = 3;

/** A Legacy-mode restore point: a full save captured at a season
 * boundary, keyed by slot + tick. */
export interface CheckpointRecord {
  key: string;
  slotId: string;
  tick: number;
  population: number;
  createdAtMs: number;
  save: SaveData;
}

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
      if (!db.objectStoreNames.contains(CHECKPOINTS)) {
        db.createObjectStore(CHECKPOINTS, { keyPath: "key" }).createIndex("slotId", "slotId");
      }
    };
    // Another tab holds the old version open — tell the player rather
    // than hanging on the title screen forever.
    req.onblocked = () =>
      reject(new Error("Dwarven Deep is open in another tab. Close it and reload to continue."));
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer tab upgrade instead of being blocked by this one.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveGame(save: SaveData): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(save);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function loadGame(slotId: string): Promise<SaveData | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(slotId);
    req.onsuccess = () => resolve((req.result as SaveData) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSave(slotId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, CHECKPOINTS], "readwrite");
    tx.objectStore(STORE).delete(slotId);
    const idx = tx.objectStore(CHECKPOINTS).index("slotId");
    const keysReq = idx.getAllKeys(slotId);
    keysReq.onsuccess = () => {
      for (const k of keysReq.result) tx.objectStore(CHECKPOINTS).delete(k);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSaves(): Promise<SaveData[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as SaveData[]) ?? []);
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
    fallenAtTick: s.fallenAtTick,
    tick: s.tick,
    realTimestampMs: s.realTimestampMs,
  }));
}

/** Store a restore point for the save's slot and prune the oldest
 * beyond MAX_CHECKPOINTS_PER_SLOT. */
export async function saveCheckpoint(save: SaveData): Promise<void> {
  const db = await openDb();
  const existing = await listCheckpoints(save.slotId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINTS, "readwrite");
    const store = tx.objectStore(CHECKPOINTS);
    const record: CheckpointRecord = {
      key: `${save.slotId}:${save.tick}`,
      slotId: save.slotId,
      tick: save.tick,
      population: save.dwarves.length,
      createdAtMs: Date.now(),
      save,
    };
    store.put(record);
    const all = [...existing.filter((c) => c.key !== record.key), record].sort((a, b) => b.tick - a.tick);
    for (const old of all.slice(MAX_CHECKPOINTS_PER_SLOT)) store.delete(old.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Restore points for a slot, newest first. */
export async function listCheckpoints(slotId: string): Promise<CheckpointRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINTS, "readonly");
    const req = tx.objectStore(CHECKPOINTS).index("slotId").getAll(slotId);
    req.onsuccess = () =>
      resolve(((req.result as CheckpointRecord[]) ?? []).sort((a, b) => b.tick - a.tick));
    req.onerror = () => reject(req.error);
  });
}
