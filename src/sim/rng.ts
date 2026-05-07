// PCG32 (oneseq variant) — fast, statistically strong, fully serializable in two
// 32-bit words. Determinism rule: every system that needs randomness in `sim/`
// must use a forked Rng. Never call Math.random() inside `sim/`.

const MUL_LO = 0x4c957f2d; // low 32 bits of 6364136223846793005
const MUL_HI = 0x5851f42d; // high 32 bits
const INC_LO = 0xda3e39cb;
const INC_HI = 0x14057b7e;

// 64-bit unsigned multiply done with two 32-bit halves. We cannot use BigInt in
// the tick hot loop without measurable cost, so this is the cheaper path.
function mul64(aHi: number, aLo: number, bHi: number, bLo: number): [number, number] {
  const aLoHi = aLo >>> 16;
  const aLoLo = aLo & 0xffff;
  const bLoHi = bLo >>> 16;
  const bLoLo = bLo & 0xffff;

  const ll = aLoLo * bLoLo;
  const lh = aLoLo * bLoHi;
  const hl = aLoHi * bLoLo;
  const hh = aLoHi * bLoHi;

  // Sum partial products with proper carry tracking.
  const lo16 = ll & 0xffff;
  let mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  const lo32 = ((mid & 0xffff) << 16) | lo16;

  let hi32 = (mid >>> 16) + (lh >>> 16) + (hl >>> 16) + hh + Math.imul(aLo, bHi) + Math.imul(aHi, bLo);
  hi32 = hi32 >>> 0;

  return [hi32, lo32 >>> 0];
}

function add64(aHi: number, aLo: number, bHi: number, bLo: number): [number, number] {
  const lo = (aLo + bLo) >>> 0;
  const carry = lo < aLo >>> 0 ? 1 : 0;
  const hi = (aHi + bHi + carry) >>> 0;
  return [hi, lo];
}

export class Rng {
  // state stored as [hi, lo]
  stateHi: number;
  stateLo: number;

  constructor(stateHi: number, stateLo: number) {
    this.stateHi = stateHi >>> 0;
    this.stateLo = stateLo >>> 0;
  }

  /** Standard PCG32 step. Returns a uint32. */
  next(): number {
    const oldHi = this.stateHi;
    const oldLo = this.stateLo;

    const [mulHi, mulLo] = mul64(oldHi, oldLo, MUL_HI, MUL_LO);
    const [newHi, newLo] = add64(mulHi, mulLo, INC_HI, INC_LO);
    this.stateHi = newHi;
    this.stateLo = newLo;

    // XSH-RR output function: rot = oldHi >> 27, xorshifted = ((oldHi >>> 18) ^ oldHi) >>> 27 ... but we need
    // a 64-bit rotation. Using the standard PCG32 output:
    // xorshifted = ((state >> 18u) ^ state) >> 27u
    // rot = state >> 59u
    // out = rotr32(xorshifted, rot)
    // Operating on the 64-bit state requires shifting across hi/lo.
    const xs1Hi = (oldHi >>> 18) | 0;
    const xs1Lo = ((oldLo >>> 18) | (oldHi << 14)) >>> 0;
    const xHi = (xs1Hi ^ oldHi) >>> 0;
    const xLo = (xs1Lo ^ oldLo) >>> 0;
    // shift right 27 -> top 37 bits live in (xHi << 5 | xLo >>> 27)
    const xorshifted = ((xHi << 5) | (xLo >>> 27)) >>> 0;
    const rot = oldHi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  }

  /** [0, 1) float. */
  nextFloat(): number {
    return this.next() / 0x100000000;
  }

  /** Integer in [min, max) — half-open. */
  nextRange(min: number, max: number): number {
    const span = max - min;
    if (span <= 0) return min;
    // Unbiased rejection-sample in the rare case span doesn't divide 2^32.
    const limit = (0x100000000 - (0x100000000 % span)) >>> 0;
    let r: number;
    do {
      r = this.next();
    } while (r >= limit);
    return min + (r % span);
  }

  /** Independent stream forked by label, deterministically. */
  fork(label: string): Rng {
    const h = hashLabel(label);
    // Mix label hash into state via splitmix64 step.
    let mixHi = (this.stateHi ^ h.hi) >>> 0;
    let mixLo = (this.stateLo ^ h.lo) >>> 0;
    [mixHi, mixLo] = splitmix64Step(mixHi, mixLo);
    return new Rng(mixHi, mixLo);
  }

  serialize(): [number, number] {
    return [this.stateHi, this.stateLo];
  }

  static deserialize(s: [number, number]): Rng {
    return new Rng(s[0], s[1]);
  }

  static fromSeed(seed: number): Rng {
    // Expand a 32-bit seed to 64 bits via splitmix64.
    let s0Hi = 0;
    let s0Lo = (seed >>> 0) || 0x9e3779b9;
    [s0Hi, s0Lo] = splitmix64Step(s0Hi, s0Lo);
    return new Rng(s0Hi, s0Lo);
  }
}

// 64-bit splitmix step. Used both for seed expansion and for fork mixing.
function splitmix64Step(hi: number, lo: number): [number, number] {
  // z = state += 0x9E3779B97F4A7C15
  const ADD_HI = 0x9e3779b9;
  const ADD_LO = 0x7f4a7c15;
  let [zHi, zLo] = add64(hi, lo, ADD_HI, ADD_LO);
  // z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
  let shHi = zHi >>> 30;
  let shLo = ((zLo >>> 30) | (zHi << 2)) >>> 0;
  zHi = (zHi ^ shHi) >>> 0;
  zLo = (zLo ^ shLo) >>> 0;
  [zHi, zLo] = mul64(zHi, zLo, 0xbf58476d, 0x1ce4e5b9);
  // z = (z ^ (z >> 27)) * 0x94D049BB133111EB
  shHi = zHi >>> 27;
  shLo = ((zLo >>> 27) | (zHi << 5)) >>> 0;
  zHi = (zHi ^ shHi) >>> 0;
  zLo = (zLo ^ shLo) >>> 0;
  [zHi, zLo] = mul64(zHi, zLo, 0x94d049bb, 0x133111eb);
  // z = z ^ (z >> 31)
  shHi = zHi >>> 31;
  shLo = ((zLo >>> 31) | (zHi << 1)) >>> 0;
  return [(zHi ^ shHi) >>> 0, (zLo ^ shLo) >>> 0];
}

function hashLabel(s: string): { hi: number; lo: number } {
  // FNV-1a 64-bit, returned as two 32-bit halves.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) & 0xff;
    lo = (lo ^ c) >>> 0;
    [hi, lo] = mul64(hi, lo, 0x00000100, 0x000001b3);
  }
  return { hi, lo };
}
