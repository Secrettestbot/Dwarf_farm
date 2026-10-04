import { CURRENT_SAVE_VERSION, OLDEST_SUPPORTED_SAVE_VERSION, SaveData } from "./schema";

// Versioned save migrations. Every load — IndexedDB or an imported
// file — funnels through migrateSave() before restore() touches it, so
// format evolution lives HERE as an explicit vN→vN+1 chain instead of
// scattered per-field `?? default` branches. restore() keeps its
// defensive optional handling as a second net, but new format changes
// should ship with a migration step, then bump CURRENT_SAVE_VERSION.
// See the version history above CURRENT_SAVE_VERSION in schema.ts.

type RawSave = Record<string, unknown>;

/** One step: takes a save at version N, returns it at version N+1
 * (the runner stamps the version). Keyed by the FROM version. */
const MIGRATIONS: Record<number, (s: RawSave) => RawSave> = {
  // v2 → v3: the rooms-need-furniture overhaul, plus fog-of-war
  // (seenMask), skillXp, health and the other optional blocks that
  // landed during v3's life. Deliberately an identity step — v2 saves
  // are upgraded, not dropped (schema.ts records why the original
  // "drop v2" plan was never enforced). Every v3 addition is optional:
  // a v2 "complete" room was already furnished by the old auto-stamp
  // path, a missing seenMask restores as fully explored, and the rest
  // default in restore(). The step exists so the chain is contiguous.
  2: (s) => ({ ...s }),
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
 *
 * Throws (with a player-readable message) on:
 * - a missing or non-integer `version`. Every save this game has ever
 *   written — back to the session-1 v1 format — stamps a numeric
 *   version, so a record without one was not produced by us (or was
 *   hand-edited / truncated). Earlier builds silently assumed v2 here,
 *   which would push a malformed object through every migration and
 *   into restore(); failing loudly is the safer contract.
 * - a version older than OLDEST_SUPPORTED_SAVE_VERSION (v1), and
 * - a version from a NEWER build than this one — restoring those
 *   silently would drop fields the newer build depends on.
 */
export function migrateSave(raw: SaveData): SaveData {
  let save = raw as unknown as RawSave;
  if (typeof save.version !== "number" || !Number.isInteger(save.version)) {
    throw new Error("Save has no valid version number — it was not written by Dwarven Deep.");
  }
  let version = save.version;
  if (version > CURRENT_SAVE_VERSION) {
    throw new Error(
      `Save version ${version} is newer than this build (v${CURRENT_SAVE_VERSION}) — update the game to load it.`,
    );
  }
  if (version < OLDEST_SUPPORTED_SAVE_VERSION) {
    throw new Error(
      `Save version ${version} is too old to load (oldest supported: v${OLDEST_SUPPORTED_SAVE_VERSION}).`,
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
  return save as unknown as SaveData;
}
