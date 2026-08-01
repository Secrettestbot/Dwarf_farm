import { CURRENT_SAVE_VERSION, SaveV1 } from "./schema";

// Versioned save migrations. Every load — IndexedDB or an imported
// file — funnels through migrateSave() before restore() touches it, so
// format evolution lives HERE as an explicit vN→vN+1 chain instead of
// scattered per-field `?? default` branches. restore() keeps its
// defensive optional handling as a second net, but new format changes
// should ship with a migration step, then bump CURRENT_SAVE_VERSION.

type RawSave = Record<string, unknown>;

/** One step: takes a save at version N, returns it at version N+1
 * (the runner stamps the version). Keyed by the FROM version. */
const MIGRATIONS: Record<number, (s: RawSave) => RawSave> = {
  // v2 → v3: fog-of-war (seenMask), skillXp, health, and the other
  // optional blocks were introduced across v3's life with restore-side
  // defaults. Nothing to transform — the fields legitimately default —
  // but the step exists so the chain is contiguous from the oldest
  // saves in the wild.
  2: (s) => s,
  // v3 → v4: entity-id-keyed fields (top-level hostileNames, raw
  // caravan.brokerId, raw-id grudge keys) were superseded by
  // index-based encodings. Old ids cannot be mapped onto a restored
  // world (that was the bug), so the legacy fields are dropped here
  // rather than restored wrongly: the warband loses its pinned name,
  // the broker re-resolves at the next caravan, feuds reset to peace.
  3: (s) => {
    const out = { ...s };
    delete out.hostileNames;
    delete out.grudges;
    if (out.caravan && typeof out.caravan === "object") {
      const caravan = { ...(out.caravan as RawSave) };
      delete caravan.brokerId;
      out.caravan = caravan;
    }
    return out;
  },
};

/**
 * Bring a raw stored/imported save up to CURRENT_SAVE_VERSION.
 * Throws on saves from a NEWER build than this one — restoring those
 * silently would drop fields the newer build depends on.
 */
export function migrateSave(raw: SaveV1): SaveV1 {
  let save = raw as unknown as RawSave;
  let version = typeof save.version === "number" ? save.version : 2;
  if (version > CURRENT_SAVE_VERSION) {
    throw new Error(
      `Save version ${version} is newer than this build (v${CURRENT_SAVE_VERSION}) — update the game to load it.`,
    );
  }
  while (version < CURRENT_SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new Error(`No migration from save version ${version} — cannot load.`);
    }
    save = step(save);
    version++;
    save.version = version;
  }
  return save as unknown as SaveV1;
}
