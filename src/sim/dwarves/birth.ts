// Reproduction helpers. Birth picks a child's name (random first name + the
// father's surname), inherits a few traits from the parents (with one fresh
// random for novelty), and seeds a baseline skill table. The child enters
// the colony at age 0 and grows up by simply not dying — the existing aging
// system increments their age each year, and chooseTask gates work tasks
// behind a minimum age so they don't pick up pickaxes at three.

import { Rng } from "../rng";
import { rollName, rollFirstName } from "./names";
import { TraitDef, TRAITS_BY_ID, rollTraits } from "./traits";
import { SkillLevels } from "./skills";

/**
 * Build a list of trait IDs for a newborn. We sample 1 trait from each
 * parent (when available) plus 1 freshly rolled trait, deduplicated and
 * filtered to honour conflict groups so the child never carries
 * mutually-incompatible traits.
 */
export function inheritTraits(rng: Rng, motherTraitIds: string[], fatherTraitIds: string[]): string[] {
  const chosen: TraitDef[] = [];
  const usedGroups = new Set<string>();
  const taken = new Set<string>();

  function tryTake(id: string | undefined): void {
    if (!id) return;
    if (taken.has(id)) return;
    const t = TRAITS_BY_ID[id];
    if (!t) return;
    if (t.conflictGroup && usedGroups.has(t.conflictGroup)) return;
    chosen.push(t);
    taken.add(id);
    if (t.conflictGroup) usedGroups.add(t.conflictGroup);
  }

  // Inherit one from each parent, picked at random from their list.
  if (motherTraitIds.length > 0) tryTake(motherTraitIds[rng.nextRange(0, motherTraitIds.length)]);
  if (fatherTraitIds.length > 0) tryTake(fatherTraitIds[rng.nextRange(0, fatherTraitIds.length)]);

  // Plus a freshly rolled trait so children aren't strict subsets of parents.
  const fresh = rollTraits(rng, 1);
  if (fresh.length > 0) tryTake(fresh[0].id);

  return chosen.map((t) => t.id);
}

/**
 * Generate a child's full name: a fresh first name plus the father's
 * surname (if any), defaulting to the mother's if the father has none.
 */
export function rollChildName(
  rng: Rng,
  motherFullName: string,
  fatherFullName: string,
  used: Set<string>,
): string {
  const first = rollFirstName(rng, used);
  const surname =
    fatherFullName.split(" ").slice(1).join(" ") ||
    motherFullName.split(" ").slice(1).join(" ") ||
    "Stoneborn";
  return `${first} ${surname}`;
}

/** A baseline skill table for a newborn (everything Novice). */
export function newbornSkills(): SkillLevels {
  // Skills are filled in lazily as the child works; the empty object is
  // fine — chooseTask doesn't read skills yet, and the inspector treats
  // missing entries as level 1 (Novice).
  return {};
}

// Re-export rollFirstName so callers don't have to import from two places.
export { rollName };
