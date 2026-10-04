import { SaveData } from "./schema";
import { migrateSave } from "./migrations";
import { CHUNK_SIZE } from "../sim/world/grid";

// Export/import of saves as JSON files — player backups, moving a
// fortress between machines, and attaching a save to a bug report.
// The two binary fields (tileOverrides, seenMask) are Uint8Arrays,
// which JSON would mangle into index-keyed objects, so they travel
// base64-encoded under a marker flag.

const ENCODING_MARKER = "dwarven-deep-save-v1";

/** Upper bound on width × height accepted from an imported file. The
 * shipping world is 400×2000 (800k tiles); anything wildly larger is a
 * corrupt or hostile file that would make worldgen allocate gigabytes. */
export const MAX_IMPORT_WORLD_TILES = 4_000_000;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64: string, field: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error(`Save file is invalid: \`${field}\` is not valid base64.`);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function exportSaveToJson(save: SaveData): string {
  return JSON.stringify({
    encoding: ENCODING_MARKER,
    save: {
      ...save,
      tileOverrides: toBase64(save.tileOverrides),
      seenMask: save.seenMask ? toBase64(save.seenMask) : undefined,
    },
  });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Structural check of a raw (pre-migration, binary fields still
 * base64) save object. Covers what every supported version (v2+)
 * shares and what restore() would crash or misbehave on: required
 * fields with the right primitive types, world dimensions worldgen can
 * build, and per-entry shape of the arrays restore() walks. It is not
 * a full schema validation — optional blocks are only type-checked
 * when present. Returns a list of human-readable problems (empty = ok).
 */
export function validateRawSave(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) problems.push(msg); };
  const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v) ?? String(v));

  need(isInt(raw.version), `\`version\` must be an integer (got ${show(raw.version)})`);
  need(typeof raw.slotId === "string", "`slotId` must be a string");
  need(typeof raw.fortressName === "string", "`fortressName` must be a string");
  need(raw.mode === "legacy" || raw.mode === "saga", `\`mode\` must be "legacy" or "saga" (got ${show(raw.mode)})`);
  need(isInt(raw.seed), `\`seed\` must be an integer (got ${show(raw.seed)})`);
  need(isInt(raw.tick) && raw.tick >= 0, `\`tick\` must be a non-negative integer (got ${show(raw.tick)})`);
  need(raw.realTimestampMs === undefined || isNum(raw.realTimestampMs), "`realTimestampMs` must be a number");

  const dimsOk = (["width", "height"] as const).every((k) => {
    const v = raw[k];
    const ok = isInt(v) && v > 0 && v % CHUNK_SIZE === 0;
    need(ok, `\`${k}\` must be a positive multiple of ${CHUNK_SIZE} (got ${show(v)})`);
    return ok;
  });
  const width = raw.width as number;
  const height = raw.height as number;
  if (dimsOk) {
    need(width * height <= MAX_IMPORT_WORLD_TILES,
      `world size ${width}×${height} exceeds the ${MAX_IMPORT_WORLD_TILES.toLocaleString("en-US")}-tile limit`);
  }

  if (!isObj(raw.rngStates)) {
    problems.push("`rngStates` must be an object");
  } else {
    for (const [k, v] of Object.entries(raw.rngStates)) {
      need(Array.isArray(v) && v.length === 2 && v.every(isInt), `\`rngStates.${k}\` must be a pair of integers`);
    }
  }

  need(typeof raw.tileOverrides === "string", "`tileOverrides` (terrain data) is missing");
  need(raw.seenMask === undefined || typeof raw.seenMask === "string", "`seenMask` must be a base64 string");

  if (!Array.isArray(raw.dwarves)) {
    problems.push("`dwarves` must be an array");
  } else {
    raw.dwarves.forEach((d: unknown, i) => {
      if (!isObj(d)) { problems.push(`\`dwarves[${i}]\` must be an object`); return; }
      need(typeof d.name === "string", `\`dwarves[${i}].name\` must be a string`);
      const inBounds = isInt(d.x) && isInt(d.y) && (!dimsOk || (d.x >= 0 && d.y >= 0 && d.x < width && d.y < height));
      need(inBounds, `\`dwarves[${i}]\` position (${show(d.x)}, ${show(d.y)}) must be integer tile coordinates inside the world`);
    });
  }

  if (!Array.isArray(raw.blueprints)) {
    problems.push("`blueprints` must be an array");
  } else {
    raw.blueprints.forEach((b: unknown, i) => {
      if (!isObj(b)) { problems.push(`\`blueprints[${i}]\` must be an object`); return; }
      need(isInt(b.id), `\`blueprints[${i}].id\` must be an integer`);
      need(typeof b.kind === "string", `\`blueprints[${i}].kind\` must be a string`);
      need(typeof b.status === "string", `\`blueprints[${i}].status\` must be a string`);
      need(Array.isArray(b.cells) && b.cells.length % 2 === 0 && b.cells.every(isInt),
        `\`blueprints[${i}].cells\` must be an even-length array of integers`);
    });
  }

  for (const k of ["plannerNextId", "plannerCompleted", "plannerAccum", "cameraX", "cameraY", "zoomIndex"]) {
    need(raw[k] === undefined || isNum(raw[k]), `\`${k}\` must be a number`);
  }
  for (const k of ["events", "items", "hostiles", "pets", "graves", "artifacts", "books"]) {
    need(raw[k] === undefined || Array.isArray(raw[k]), `\`${k}\` must be an array when present`);
  }
  need(raw.stockpile === undefined || isObj(raw.stockpile), "`stockpile` must be an object when present");
  return problems;
}

function invalid(problems: string[]): Error {
  const MAX = 5;
  const shown = problems.slice(0, MAX).join("; ");
  const more = problems.length > MAX ? ` (and ${problems.length - MAX} more)` : "";
  return new Error(`Save file is invalid: ${shown}${more}.`);
}

/** Parse an exported save file back into a SaveData, running migrations.
 * Throws with a readable message on anything that isn't ours or that
 * fails the structural check. */
export function importSaveFromJson(text: string): SaveData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid save file (not JSON).");
  }
  if (!isObj(parsed) || parsed.encoding !== ENCODING_MARKER || !isObj(parsed.save)) {
    throw new Error("Not a Dwarven Deep save file.");
  }
  const raw: Record<string, unknown> = { ...parsed.save };
  if (typeof raw.tileOverrides !== "string") {
    throw new Error("Save file is missing its terrain data.");
  }
  const problems = validateRawSave(raw);
  if (problems.length > 0) throw invalid(problems);

  const overrides = fromBase64(raw.tileOverrides, "tileOverrides");
  // Header: u16 width, u16 height, u32 run count, then 7 bytes per run.
  if (overrides.byteLength < 8) throw invalid(["`tileOverrides` is truncated"]);
  const dv = new DataView(overrides.buffer, overrides.byteOffset, overrides.byteLength);
  const ow = dv.getUint16(0, true);
  const oh = dv.getUint16(2, true);
  const runs = dv.getUint32(4, true);
  if (ow !== raw.width || oh !== raw.height) {
    throw invalid([`terrain data is for a ${ow}×${oh} world but the save says ${String(raw.width)}×${String(raw.height)}`]);
  }
  if (overrides.byteLength !== 8 + runs * 7) {
    throw invalid([`\`tileOverrides\` length ${overrides.byteLength} does not match its ${runs} runs`]);
  }
  raw.tileOverrides = overrides;
  if (typeof raw.seenMask === "string") raw.seenMask = fromBase64(raw.seenMask, "seenMask");
  return migrateSave(raw as unknown as SaveData);
}
