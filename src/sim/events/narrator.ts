// Narrator: turns sim happenings into log lines in a consistent voice.
// The voice (GDD §9.2): short sentences, slightly wry, written as record
// rather than UI status. Every line uses a deterministic seeded RNG so the
// catch-up worker generates the same chronicle as live play.

import { Rng } from "../rng";
import { Blueprint, BlueprintKind } from "../planner/blueprint";

/** Choose deterministically from a non-empty array. */
function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[rng.nextRange(0, arr.length)];
}

/** Free-form depth phrasing for use in event text. */
function depthPhrase(y: number, spawnY: number): string {
  const delta = y - spawnY;
  if (delta < -2) return "above the entrance";
  if (delta < 4) return "near the surface";
  if (delta < 20) return "in the upper halls";
  if (delta < 60) return "in the shallow earth";
  if (delta < 150) return "deep beneath the entrance";
  return "in the deep rock";
}

const KIND_LABEL: Record<BlueprintKind, string> = {
  bedroom: "bedroom",
  dining_hall: "dining hall",
  stockpile: "stockpile",
  corridor: "tunnel",
  mine: "mine",
  farm: "farm",
  stairwell: "stairwell",
};

export function narrateBlueprintBegin(rng: Rng, b: Blueprint, spawnY: number): string {
  const where = depthPhrase(b.originY, spawnY);
  switch (b.kind) {
    case "bedroom":
      return pick(rng, [
        `Plans for a new bedroom are laid out ${where}.`,
        `The colony decides on another sleeping room ${where}.`,
        `Markers are placed for a new bedroom ${where}.`,
      ]);
    case "dining_hall":
      return pick(rng, [
        `The colony breaks ground on a grand dining hall.`,
        `Long lines are scratched into the stone — the first dining hall begins.`,
      ]);
    case "stockpile":
      return pick(rng, [
        `A new stockpile is laid out ${where}.`,
        `The dwarves agree on a place to put things, ${where}.`,
      ]);
    case "corridor": {
      const horizontal = b.width > b.height;
      const lateralDir = horizontal ? "lateral" : "descending";
      return pick(rng, [
        `A ${lateralDir} tunnel is begun ${where}.`,
        `Pickaxes ring as a new ${lateralDir} passage opens ${where}.`,
      ]);
    }
    case "mine":
      return pick(rng, [
        `An ore vein has been sensed ${where}. The colony moves to dig it out.`,
        `The deep stone hums with metal ${where}; a mine is begun.`,
      ]);
    case "farm":
      return pick(rng, [
        `A farm plot is laid out ${where}. The fortress will eat better.`,
        `The dwarves mark out a new farm ${where}.`,
      ]);
    case "stairwell":
      return `A stairwell is laid out, descending into the rock.`;
    case "kitchen":
      return `The colony marks out a new kitchen ${where}.`;
    case "brewery":
      return `A brewery is laid out ${where}. The dwarves are pleased.`;
    case "smelter":
      return `A smelter is planned ${where}. Smoke will follow.`;
    case "forge":
      return `A forge is sketched in the stone ${where}.`;
    case "trade_depot":
      return `A trade depot is mapped out ${where}. The colony plans for visitors.`;
    case "library":
      return `A library is laid out ${where}. The scholars stir.`;
    case "armoury":
      return `An armoury is mapped out ${where}. The smiths sharpen their plans.`;
    case "throne_room":
      return `A throne room is sketched ${where}. The colony plans for ceremony.`;
  }
}

export function narrateBlueprintComplete(rng: Rng, b: Blueprint, spawnY: number): string {
  const where = depthPhrase(b.originY, spawnY);
  switch (b.kind) {
    case "bedroom":
      return pick(rng, [
        `The bedroom ${where} is complete.`,
        `A new bedroom is finished ${where}; some dwarf will claim it tonight.`,
      ]);
    case "dining_hall":
      return pick(rng, [
        `The dining hall is complete. Dwarves have already begun complaining about the chairs.`,
        `The grand dining hall stands finished, awaiting its first feast.`,
      ]);
    case "stockpile":
      return pick(rng, [
        `The stockpile is finished. A few dwarves have started arguing about how to organise it.`,
        `The new stockpile is open. The hauling has already begun.`,
      ]);
    case "corridor":
      return pick(rng, [
        `A new tunnel is finished, ${where}.`,
        `The dwarves cheer — briefly — and move on. Another passage is open ${where}.`,
      ]);
    case "mine":
      return pick(rng, [
        `The new mine is open ${where}. The first ore has been drawn from the rock.`,
        `Ore tumbles into the dust ${where}; the mine is complete.`,
      ]);
    case "farm":
      return pick(rng, [
        `The new farm is dug ${where}. Cave wheat will follow.`,
        `The farm is finished ${where}. The dwarves begin to plant.`,
      ]);
    case "stairwell":
      return `The stairwell is finished. The colony reaches further into the mountain.`;
    case "kitchen":
      return `The kitchen is complete ${where}. The cooks light their first fire.`;
    case "brewery":
      return `The brewery stands ready ${where}. Barrels are rolled into place.`;
    case "smelter":
      return `The smelter is fired ${where}. The first bars are cast.`;
    case "forge":
      return `The forge rings to life ${where}. The first tool is hammered out.`;
    case "trade_depot":
      return `The trade depot is finished ${where}. The first caravan will be welcome.`;
    case "library":
      return `The library is opened ${where}. The first books are placed on the desks.`;
    case "armoury":
      return `The armoury opens ${where}. The first weapons go on the racks.`;
    case "throne_room":
      return `The throne room stands finished ${where}. The hall awaits its first procession.`;
  }
}

export function narrateOreFirstStrike(rng: Rng, dwarfName: string, depth: number, spawnY: number): string {
  const where = depthPhrase(depth, spawnY);
  return pick(rng, [
    `${dwarfName} strikes the first ore vein the colony has seen, ${where}.`,
    `${dwarfName} is the first to break ore, ${where}. There will be more.`,
  ]);
}

export function narrateArrival(rng: Rng, names: string[]): string {
  const count = names.length;
  if (count === 1) {
    return pick(rng, [
      `${names[0]} has arrived at the gate, looking for work.`,
      `A lone dwarf, ${names[0]}, has joined the fortress.`,
      `${names[0]} walks out of the dust and asks to stay. The colony agrees.`,
    ]);
  }
  if (count <= 3) {
    const list = count === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]}, and ${names[2]}`;
    return pick(rng, [
      `${list} arrive at the gate, seeking work. They are welcomed in.`,
      `${list} have joined the fortress.`,
    ]);
  }
  return pick(rng, [
    `${count} dwarves arrive at the gate, seeking refuge in the mountain. They are welcomed in.`,
    `A small caravan brings ${count} new dwarves to the fortress.`,
    `${count} new dwarves have joined the fortress: ${names.slice(0, 2).join(", ")} and ${count - 2} others.`,
  ]);
}

export function narrateHostileSpawn(rng: Rng, kindArticle: string, depth: number, spawnY: number): string {
  const where = depthPhrase(depth, spawnY);
  return pick(rng, [
    `${kindArticle.charAt(0).toUpperCase() + kindArticle.slice(1)} has appeared ${where}. The dwarves should beware.`,
    `${kindArticle.charAt(0).toUpperCase() + kindArticle.slice(1)} has been heard ${where}.`,
    `Something stirs ${where} — ${kindArticle}.`,
  ]);
}

export function narrateHostileSlain(rng: Rng, dwarfName: string, kindName: string): string {
  return pick(rng, [
    `${dwarfName} has slain a ${kindName}.`,
    `A ${kindName} lies dead at ${dwarfName}'s feet.`,
    `${dwarfName} has put down a ${kindName}.`,
  ]);
}

export function narratePairing(rng: Rng, a: string, b: string): string {
  return pick(rng, [
    `${a} and ${b} have become partners.`,
    `Old friends ${a} and ${b} have decided to marry.`,
    `${a} and ${b} have bonded over a long winter and become a couple.`,
  ]);
}

export function narrateBirth(rng: Rng, child: string, mother: string, father: string): string {
  return pick(rng, [
    `${child} has been born to ${mother} and ${father}.`,
    `A child, ${child}, has been born in the mountain. ${mother} and ${father} are well.`,
    `${mother} has given birth to ${child}. The fortress is one larger.`,
  ]);
}

export function narrateBereavement(rng: Rng, survivor: string, deceased: string, yearsTogether: number): string {
  if (yearsTogether < 2) {
    return pick(rng, [
      `${survivor} mourns ${deceased}, their partner.`,
      `${survivor} sits alone tonight. ${deceased} is gone.`,
    ]);
  }
  return pick(rng, [
    `${survivor} grieves for ${deceased}, their partner of ${yearsTogether} years.`,
    `${yearsTogether} years bonded, and now ${survivor} stands alone. ${deceased} is dead.`,
    `${survivor} weeps for ${deceased}. They were partners ${yearsTogether} years.`,
  ]);
}

export function narrateDeath(rng: Rng, name: string, profession: string, age: number, cause: string): string {
  const opts = cause === "old age"
    ? [
        `${name}, ${profession}, has died of old age. Aged ${age} years.`,
        `Old ${name} is dead. ${age} years in the mountain, the last of them spent watching the young.`,
        `${name} the ${profession.toLowerCase()} did not wake this morning. ${age} years.`,
        `${name}, ${profession}, has passed peacefully in their sleep at ${age}.`,
      ]
    : [
        `${name}, ${profession}, has died (${cause}). Aged ${age} years.`,
      ];
  return pick(rng, opts);
}

export function narrateFounding(names: string[]): string {
  if (names.length === 0) return `Seven dwarves enter the mountain.`;
  // List the first 2-3 founders by name; the rest as count.
  const head = names.slice(0, 2).join(", ");
  const remaining = names.length - 2;
  if (remaining <= 0) return `${head} enter the mountain.`;
  return `${head}, and ${remaining} others enter the mountain.`;
}

export { KIND_LABEL };
