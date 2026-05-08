// 16-color palette tuned for the dwarven-deep aesthetic. Surface earth tones
// shifting to cool greys deeper down. Index 0 reserved as transparent.

export const PALETTE: string[] = [
  "transparent", // 0 — transparent
  "#1a1410", // 1 — near-black
  "#2a2620", // 2 — dark earth
  "#3a3228", // 3 — earth shadow
  "#5a4633", // 4 — soil
  "#6b4a2b", // 5 — dirt
  "#8a6a3a", // 6 — ore brown
  "#b89868", // 7 — sand
  "#3f4046", // 8 — granite shadow
  "#5a5a62", // 9 — granite
  "#6a6a72", // 10 — stone
  "#8a8a92", // 11 — stone highlight
  "#7aa040", // 12 — sprout green (was torch glow; the few torch / cap pixels
             //      that referenced it now use 13 / blonde, which reads as
             //      lit gold under candlelight anyway)
  "#e0c080", // 13 — beard blonde
  "#a04030", // 14 — clothes red
  "#3060a0", // 15 — clothes blue
];

export function hex(c: number): string {
  return PALETTE[c & 15] ?? "#ff00ff";
}

export function rgbFromHex(hexStr: string): [number, number, number] {
  if (hexStr === "transparent") return [0, 0, 0];
  const n = parseInt(hexStr.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
