// Procedural dwarf names. Combines a first-name syllable pair with a clan
// surname compound. Deterministic given the rng — the same seed always
// produces the same founders.

import { Rng } from "../rng";

const FIRST_PREFIXES = [
  "Bor", "Dur", "Thra", "Mog", "Bal", "Kil", "Fal", "Dwal", "Or", "Throg",
  "Brom", "Hel", "Gim", "Khaz", "Drog", "Vor", "Fund", "Sten", "Rur", "Mol",
  "Brak", "Strom", "Norri", "Bif", "Bof", "Bom", "Glor", "Thar", "Az", "Mun",
];

const FIRST_SUFFIXES = [
  "in", "ek", "uk", "im", "an", "or", "as", "ic", "il", "och",
  "ar", "und", "ok", "ash", "od", "ulf", "is", "us", "om", "olf",
];

const SURNAME_LEFTS = [
  "Stone", "Iron", "Boulder", "Coal", "Ash", "Granite", "Forge", "Hammer",
  "Anvil", "Pick", "Mountain", "Deep", "Gold", "Silver", "Copper", "Salt",
  "Flint", "Bronze", "Marble", "Black", "Red", "Mason", "Ore",
];

const SURNAME_RIGHTS = [
  "back", "foot", "beard", "fist", "braids", "kin", "borne", "heart",
  "shanks", "helm", "vein", "axe", "delver", "warden", "knuckle", "hand",
  "shaper", "runner", "ward", "song",
];

export interface GeneratedName {
  first: string;
  surname: string;
  full: string;
}

export function rollName(rng: Rng, usedFirsts: Set<string> = new Set()): GeneratedName {
  const first = rollFirstName(rng, usedFirsts);
  const left = SURNAME_LEFTS[(rng.nextFloat() * SURNAME_LEFTS.length) | 0];
  const right = SURNAME_RIGHTS[(rng.nextFloat() * SURNAME_RIGHTS.length) | 0];
  const surname = left + right;
  return { first, surname, full: `${first} ${surname}` };
}

/** Just the first-name part — useful for births, where the surname is
 * inherited from the father. Tries a few times to avoid duplicates. */
export function rollFirstName(rng: Rng, usedFirsts: Set<string> = new Set()): string {
  let first = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = FIRST_PREFIXES[(rng.nextFloat() * FIRST_PREFIXES.length) | 0];
    const s = FIRST_SUFFIXES[(rng.nextFloat() * FIRST_SUFFIXES.length) | 0];
    first = p + s;
    if (!usedFirsts.has(first)) break;
  }
  return first;
}
