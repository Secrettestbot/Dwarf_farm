// Compact deterministic 2D value-noise + simplex-style gradient noise. Pure
// function of (seed, x, y). Output range roughly [-1, 1].

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function hash2i(seed: number, x: number, y: number): number {
  // Quick integer hash mixing seed with grid coords. Standard avalanche.
  let h = seed | 0;
  h = Math.imul(h ^ x, 0x85ebca6b) | 0;
  h = Math.imul(h ^ (y + 0x9e3779b9), 0xc2b2ae35) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) | 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gradDot(seed: number, ix: number, iy: number, fx: number, fy: number): number {
  const idx = hash2i(seed, ix, iy) & 7;
  const g = GRAD2[idx];
  return g[0] * fx + g[1] * fy;
}

/** Perlin-style gradient noise. Output ~[-1, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = gradDot(seed, ix, iy, fx, fy);
  const n10 = gradDot(seed, ix + 1, iy, fx - 1, fy);
  const n01 = gradDot(seed, ix, iy + 1, fx, fy - 1);
  const n11 = gradDot(seed, ix + 1, iy + 1, fx - 1, fy - 1);
  const nx0 = lerp(n00, n10, u);
  const nx1 = lerp(n01, n11, u);
  return lerp(nx0, nx1, v);
}

/** Fractal sum, normalized to ~[-1, 1]. */
export function fbm2(seed: number, x: number, y: number, octaves: number, persistence = 0.5, lacunarity = 2): number {
  let total = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += noise2(seed + i * 1013, x * freq, y * freq) * amp;
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / norm;
}
