import { TileGrid } from "../sim/world/grid";

// Run-length-encoded delta between an authoritative TileGrid and a freshly
// regenerated one from the same seed. Most cells are unchanged (the player
// only mines a small fraction of the world), so deltas compress the world to
// kilobytes even at full scale.
//
// Format (little-endian):
//   2 bytes  width
//   2 bytes  height
//   4 bytes  override count N
//   for each run:
//     4 bytes  tile index (y * width + x)
//     2 bytes  run length
//     1 byte   tile type
//   At the end: dig zone list
//     2 bytes  zone count
//     for each zone: 4 × 2 bytes (x0,y0,x1,y1)

export interface EncodedSave {
  bytes: Uint8Array;
}

export function encodeOverrides(authoritative: TileGrid, baseline: TileGrid, digZones: { x0: number; y0: number; x1: number; y1: number }[]): Uint8Array {
  if (authoritative.width !== baseline.width || authoritative.height !== baseline.height) {
    throw new Error("encodeOverrides: dimension mismatch");
  }
  const w = authoritative.width;
  const h = authoritative.height;

  // First pass: collect runs of differing tiles.
  type Run = { idx: number; len: number; type: number };
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = authoritative.getTile(x, y);
      const b = baseline.getTile(x, y);
      if (a !== b) {
        if (cur && cur.idx + cur.len === y * w + x && cur.type === a) {
          cur.len++;
        } else {
          if (cur) runs.push(cur);
          cur = { idx: y * w + x, len: 1, type: a };
        }
      } else {
        if (cur) {
          runs.push(cur);
          cur = null;
        }
      }
    }
    if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  const headerSize = 2 + 2 + 4;
  const runsSize = runs.length * (4 + 2 + 1);
  const zonesSize = 2 + digZones.length * 8;
  const out = new Uint8Array(headerSize + runsSize + zonesSize);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint16(p, w, true); p += 2;
  dv.setUint16(p, h, true); p += 2;
  dv.setUint32(p, runs.length, true); p += 4;
  for (const r of runs) {
    dv.setUint32(p, r.idx, true); p += 4;
    dv.setUint16(p, r.len, true); p += 2;
    dv.setUint8(p, r.type); p += 1;
  }
  dv.setUint16(p, digZones.length, true); p += 2;
  for (const z of digZones) {
    dv.setUint16(p, z.x0, true); p += 2;
    dv.setUint16(p, z.y0, true); p += 2;
    dv.setUint16(p, z.x1, true); p += 2;
    dv.setUint16(p, z.y1, true); p += 2;
  }
  return out;
}

export interface DecodedOverrides {
  width: number;
  height: number;
  apply(grid: TileGrid): void;
  zones: { x0: number; y0: number; x1: number; y1: number }[];
}

export function decodeOverrides(bytes: Uint8Array): DecodedOverrides {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const w = dv.getUint16(p, true); p += 2;
  const h = dv.getUint16(p, true); p += 2;
  const n = dv.getUint32(p, true); p += 4;
  const runs: { idx: number; len: number; type: number }[] = [];
  for (let i = 0; i < n; i++) {
    const idx = dv.getUint32(p, true); p += 4;
    const len = dv.getUint16(p, true); p += 2;
    const type = dv.getUint8(p); p += 1;
    runs.push({ idx, len, type });
  }
  const zoneCount = dv.getUint16(p, true); p += 2;
  const zones: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < zoneCount; i++) {
    const x0 = dv.getUint16(p, true); p += 2;
    const y0 = dv.getUint16(p, true); p += 2;
    const x1 = dv.getUint16(p, true); p += 2;
    const y1 = dv.getUint16(p, true); p += 2;
    zones.push({ x0, y0, x1, y1 });
  }
  return {
    width: w,
    height: h,
    apply(grid) {
      for (const r of runs) {
        for (let k = 0; k < r.len; k++) {
          const idx = r.idx + k;
          const x = idx % w;
          const y = (idx / w) | 0;
          grid.setTile(x, y, r.type);
        }
      }
    },
    zones,
  };
}
