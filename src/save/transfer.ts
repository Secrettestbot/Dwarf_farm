import { SaveV1 } from "./schema";
import { migrateSave } from "./migrations";

// Export/import of saves as JSON files — player backups, moving a
// fortress between machines, and attaching a save to a bug report.
// The two binary fields (tileOverrides, seenMask) are Uint8Arrays,
// which JSON would mangle into index-keyed objects, so they travel
// base64-encoded under a marker flag.

const ENCODING_MARKER = "dwarven-deep-save-v1";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function exportSaveToJson(save: SaveV1): string {
  return JSON.stringify({
    encoding: ENCODING_MARKER,
    save: {
      ...save,
      tileOverrides: toBase64(save.tileOverrides),
      seenMask: save.seenMask ? toBase64(save.seenMask) : undefined,
    },
  });
}

/** Parse an exported save file back into a SaveV1, running migrations.
 * Throws with a readable message on anything that isn't ours. */
export function importSaveFromJson(text: string): SaveV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid save file (not JSON).");
  }
  const wrapper = parsed as { encoding?: string; save?: Record<string, unknown> };
  if (wrapper.encoding !== ENCODING_MARKER || !wrapper.save) {
    throw new Error("Not a Dwarven Deep save file.");
  }
  const raw = { ...wrapper.save };
  if (typeof raw.tileOverrides !== "string") {
    throw new Error("Save file is missing its terrain data.");
  }
  raw.tileOverrides = fromBase64(raw.tileOverrides);
  if (typeof raw.seenMask === "string") raw.seenMask = fromBase64(raw.seenMask);
  return migrateSave(raw as unknown as SaveV1);
}
