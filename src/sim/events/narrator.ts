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
  kitchen: "kitchen",
  brewery: "brewery",
  smelter: "smelter",
  forge: "forge",
  trade_depot: "trade depot",
  library: "library",
  armoury: "armoury",
  throne_room: "throne room",
  pump_station: "pump station",
  mason: "mason's workshop",
  jeweller: "jeweller's workshop",
  carpenter: "carpenter's workshop",
  lumberyard: "lumberyard",
  kiln: "kiln",
  tannery: "tannery",
  loom: "loom",
  hospital: "hospital",
  tavern: "tavern",
  magma_forge: "magma forge",
  water_wheel: "water wheel",
  cemetery: "cemetery",
  great_hall: "great hall",
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
    case "pump_station":
      return `A pump station is sketched ${where}. The flood has somewhere to go.`;
    case "mason":
      return `A mason's workshop is mapped out ${where}. Rough stone will become block.`;
    case "jeweller":
      return `A jeweller's workshop is sketched ${where}. Rough stones will catch the light.`;
    case "carpenter":
      return `A carpenter's workshop is laid out ${where}. The first logs are already on the way.`;
    case "lumberyard":
      return `The colony marks a tree for felling on the surface.`;
    case "kiln":
      return `A kiln is sketched ${where}. The fire pit waits for clay.`;
    case "tannery":
      return `A tannery is laid out ${where}. Hides will become leather.`;
    case "loom":
      return `A loom is set up ${where}. Fibre will become cloth.`;
    case "hospital":
      return `A hospital is laid out ${where}. The wounded will have somewhere to recover.`;
    case "tavern":
      return `A tavern is laid out ${where}. The colony's centre of gravity shifts a little.`;
    case "magma_forge":
      return `A magma forge is sketched ${where}. The colony has tapped the deep heat.`;
    case "water_wheel":
      return `A water wheel is laid out ${where}. The river will turn the workshops.`;
    case "cemetery":
      return `A cemetery is laid out ${where}. The colony makes room for its dead.`;
    case "great_hall":
      return pick(rng, [
        `Plans for a great hall are laid out ${where}.`,
        `Space for a new gathering hall is marked off ${where}.`,
      ]);
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
    case "pump_station":
      return `The pump station is built ${where}. The flood begins to recede.`;
    case "mason":
      return `The mason's workshop opens ${where}. The first block is cut.`;
    case "jeweller":
      return `The jeweller's workshop opens ${where}. The first cut gem catches the light.`;
    case "carpenter":
      return `The carpenter's workshop opens ${where}. The first plank is sawn from a log.`;
    case "lumberyard":
      return `A tree falls on the surface. The colony has wood.`;
    case "kiln":
      return `The kiln is fired ${where}. The first pot leaves the wheel.`;
    case "tannery":
      return `The tannery opens ${where}. The first cured leather hangs on the rack.`;
    case "loom":
      return `The loom clatters to life ${where}. The first bolt of cloth comes off the warp.`;
    case "hospital":
      return `The hospital opens ${where}. The first cot is made up.`;
    case "tavern":
      return `The tavern opens its doors. The first toast is raised.`;
    case "magma_forge":
      return `The magma forge roars to life ${where}. The first masterwork tool comes off the anvil.`;
    case "water_wheel":
      return `The water wheel begins to turn. The workshops nearby pick up speed.`;
    case "cemetery":
      return `The cemetery is finished ${where}. The first plots wait, quiet.`;
    case "great_hall":
      return `The great hall is finished ${where}. Footsteps echo where stone used to be.`;
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

/** The "siege begins" chronicle line. Scales its voice with the siege
 * tier so a tenth siege doesn't read the same as the first. Must keep
 * the literal substring "siege begins" — the siege integration test
 * keys off it. Leader-clause precedence: named warlord > trolls >
 * champions > plain rabble. */
export interface SiegeArrivalContext {
  goblinCount: number;
  championCount: number;
  trollCount: number;
  /** Name of the warlord leading the host, or "" if none. */
  warlordName: string;
  /** Tier of this siege (1 = the colony's first). */
  tier: number;
}

export function narrateSiegeArrival(rng: Rng, ctx: SiegeArrivalContext): string {
  const { goblinCount, championCount, trollCount, warlordName, tier } = ctx;
  const host = tier <= 1 ? "warband" : tier <= 3 ? "war-host" : "great host";
  let clause = "";
  if (warlordName) {
    clause = `, led by ${warlordName}`;
  } else if (trollCount > 0) {
    clause = trollCount === 1 ? ` with a cave troll at their head` : ` with ${trollCount} cave trolls at their head`;
  } else if (championCount > 0) {
    clause = `, champions among them`;
  }
  // A warlord-led host can still mention the trolls/champions backing
  // them, so the heavies aren't invisible when a warlord steals the
  // leader clause.
  let backing = "";
  if (warlordName && (trollCount > 0 || championCount > 0)) {
    const parts: string[] = [];
    if (championCount > 0) parts.push(championCount === 1 ? "a champion" : `${championCount} champions`);
    if (trollCount > 0) parts.push(trollCount === 1 ? "a cave troll" : `${trollCount} cave trolls`);
    backing = ` ${parts.join(" and ")} march at their flank.`;
  }
  const tierTail = tier >= 4
    ? pick(rng, [
        " The largest host the colony has yet faced.",
        " The slopes are black with them.",
        " There has not been a war-host like it.",
      ])
    : "";
  return `The siege begins. ${goblinCount} goblins${clause} pour onto the surface near the gate as a ${host}.${backing}${tierTail} The fortress is on its own now.`;
}

/** Two dwarves bury a grudge. `peak` is how high the grudge climbed
 * before it was reconciled, so a years-deep feud ending reads bigger
 * than a patched-up spat. Thresholds mirror the argument escalation
 * wording (>= 6 "feud", >= 3 "old grievances", else minor). */
export function narrateReconciliation(rng: Rng, a: string, b: string, peak: number): string {
  if (peak >= 6) {
    return pick(rng, [
      `${a} and ${b}, enemies for as long as anyone remembers, are seen sharing a drink. The colony quietly exhales.`,
      `The feud between ${a} and ${b} is over at last. Neither will say what finally ended it.`,
      `${a} and ${b} have buried a years-deep grudge. The fortress feels lighter for it.`,
    ]);
  }
  if (peak >= 3) {
    return pick(rng, [
      `${a} and ${b} have made their peace. The arguments stop.`,
      `${a} and ${b} talk it out at last; the grudge between them fades.`,
    ]);
  }
  return pick(rng, [
    `${a} and ${b} patch up their quarrel.`,
    `${a} and ${b} let a small grievance go.`,
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

/** Context that flavours a pairing line. `aLostPartnerName` /
 * `bLostPartnerName` are set when the dwarf has a recorded
 * lostPartnerGrave — re-pairing reads very differently from a first
 * bond, and the narrator leans into that when either side is widowed.
 * Names (not just booleans) so the line can reference who came
 * before; this only fires when the dwarf still has a grave on record,
 * so the previous partner is always real. */
export interface PairingContext {
  aLostPartnerName?: string;
  bLostPartnerName?: string;
}

export function narratePairing(rng: Rng, a: string, b: string, ctx: PairingContext = {}): string {
  const bothWidowed = ctx.aLostPartnerName && ctx.bLostPartnerName;
  if (bothWidowed) {
    return pick(rng, [
      `${a} and ${b}, both of whom buried partners, have found each other. The mountain has seen worse omens.`,
      `Grief found grief: ${a} and ${b} have become partners. ${ctx.aLostPartnerName} and ${ctx.bLostPartnerName} are remembered.`,
      `${a} and ${b} have decided that two solitudes are enough. They will share a hearth now.`,
    ]);
  }
  if (ctx.aLostPartnerName || ctx.bLostPartnerName) {
    const widowed = ctx.aLostPartnerName ? a : b;
    const fresh = ctx.aLostPartnerName ? b : a;
    const lost = ctx.aLostPartnerName ?? ctx.bLostPartnerName!;
    return pick(rng, [
      `${widowed}, who once mourned ${lost}, has bonded with ${fresh}. The grief is not gone, but it has made room.`,
      `${fresh} and ${widowed} have become partners. ${widowed} carries ${lost}'s memory still, but no longer alone.`,
      `${widowed} has taken ${fresh} as a partner. ${lost} would not have begrudged it.`,
    ]);
  }
  return pick(rng, [
    `${a} and ${b} have become partners.`,
    `Old friends ${a} and ${b} have decided to marry.`,
    `${a} and ${b} have bonded over a long winter and become a couple.`,
  ]);
}

/** Context that flavours a birth line. `isFirstColonyChild` fires on
 * the very first dwarf born to colony parents (a real milestone for a
 * young fortress); `bothParentsBornInColony` fires for any later
 * birth where both parents were themselves colony-born — the
 * Three-Generations setup, worth its own voice. */
export interface BirthContext {
  isFirstColonyChild?: boolean;
  bothParentsBornInColony?: boolean;
}

export function narrateBirth(rng: Rng, child: string, mother: string, father: string, ctx: BirthContext = {}): string {
  if (ctx.isFirstColonyChild) {
    return pick(rng, [
      `${child} is the first child born in the mountain. ${mother} and ${father} did not sleep last night.`,
      `A first: ${child} has been born to ${mother} and ${father}. The fortress is no longer only its founders.`,
      `${child} is born. ${mother} and ${father} are well, and the colony has its first native daughter or son.`,
    ]);
  }
  if (ctx.bothParentsBornInColony) {
    return pick(rng, [
      `${child} has been born to ${mother} and ${father}, both of them children of this mountain. A third generation begins.`,
      `${child} is born. Their parents ${mother} and ${father} never saw the surface; neither will ${child} need to.`,
      `${mother} has given birth to ${child}. Three generations under the same stone now.`,
    ]);
  }
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

/** A survivor pays respects at a buried partner's headstone. The
 * tone shifts with how long ago the death was: raw within the first
 * season, settling within the first year, worn smooth after that.
 * `seasonsSince` is whole seasons elapsed since the burial;
 * `deceasedProfession` flavours one line per pool so the grave reads
 * as a specific dwarf rather than an anonymous plot. */
export function narrateGraveVisit(
  rng: Rng,
  visitor: string,
  deceased: string,
  deceasedProfession: string,
  seasonsSince: number,
): string {
  const prof = deceasedProfession.toLowerCase();
  if (seasonsSince < 1) {
    return pick(rng, [
      `${visitor} kneels at ${deceased}'s grave. The earth is still fresh.`,
      `${visitor} has not learned to pass the cemetery without stopping. ${deceased} is barely cold.`,
      `${visitor} stands at ${deceased}'s headstone, jaw tight, saying nothing.`,
    ]);
  }
  if (seasonsSince < 4) {
    return pick(rng, [
      `${visitor} visits ${deceased}'s grave. A season turns; the ache does not.`,
      `${visitor} brushes the dust from ${deceased}'s headstone and stays a while.`,
      `${visitor} sits with ${deceased} the ${prof} for a long while. The mountain is quiet.`,
    ]);
  }
  return pick(rng, [
    `${visitor} visits ${deceased}'s grave, as they have for years now. Old grief, worn smooth.`,
    `Years on, ${visitor} still finds their way to ${deceased}'s headstone.`,
    `${visitor} stands at ${deceased} the ${prof}'s grave. Time has dulled the edge, not the memory.`,
  ]);
}

/** Disease cause labels the death narrator recognises (mirrors
 * DISEASE_DEFS[].label in sim.ts). Kept as a literal list here so the
 * narrator stays free of a sim-internals import; if a new disease is
 * added there, it simply falls through to the generic line until
 * listed here. */
const DISEASE_CAUSE_LABELS: readonly string[] = ["cave cough", "deep fever", "wound sickness"];

export function narrateDeath(rng: Rng, name: string, profession: string, age: number, cause: string): string {
  const prof = profession.toLowerCase();
  if (cause === "old age") {
    return pick(rng, [
      `${name}, ${profession}, has died of old age. Aged ${age} years.`,
      `Old ${name} is dead. ${age} years in the mountain, the last of them spent watching the young.`,
      `${name} the ${prof} did not wake this morning. ${age} years.`,
      `${name}, ${profession}, has passed peacefully in their sleep at ${age}.`,
    ]);
  }
  // Slain by a hostile — cause is "slain by <article>" (e.g. "a
  // goblin scout"). Pull the foe out for a sharper line.
  if (cause.startsWith("slain by ")) {
    const foe = cause.slice("slain by ".length);
    return pick(rng, [
      `${name}, ${profession}, has been killed by ${foe}. Aged ${age} years.`,
      `${name} fell to ${foe}, ${prof} to the last. ${age} years.`,
      `${foe} cut down ${name} the ${prof}. The mountain is poorer for it.`,
      `${name} is dead, ${age} years old, struck down by ${foe}.`,
    ]);
  }
  // Murdered by another dwarf — cause is "struck dead by <name>".
  if (cause.startsWith("struck dead by ")) {
    const killer = cause.slice("struck dead by ".length);
    return pick(rng, [
      `${name}, ${profession}, was struck dead by ${killer}. The colony will not soon forget.`,
      `${killer} killed ${name} the ${prof} in a fit of rage. ${age} years, ended by one of their own.`,
      `${name} is dead at the hand of ${killer}. ${age} years. Such things should not happen underground.`,
    ]);
  }
  if (DISEASE_CAUSE_LABELS.includes(cause)) {
    return pick(rng, [
      `${name}, ${profession}, has died of ${cause}. The healers could not save them. ${age} years.`,
      `${cause} took ${name} the ${prof} in the end. ${age} years.`,
      `${name} is dead of ${cause}, ${age} years old. The sickness moved faster than the medicine.`,
    ]);
  }
  if (cause === "starvation") {
    return pick(rng, [
      `${name}, ${profession}, has starved to death. ${age} years, and the stores were empty.`,
      `${name} the ${prof} is dead of hunger. ${age} years. The fortress failed to feed its own.`,
      `Starvation has taken ${name}. ${age} years old, and not a meal to be found.`,
    ]);
  }
  if (cause === "dehydration") {
    return pick(rng, [
      `${name}, ${profession}, has died of thirst. ${age} years, with the wells run dry.`,
      `${name} the ${prof} is dead of dehydration. ${age} years. There was nothing left to drink.`,
      `Thirst has claimed ${name}. ${age} years old, and the barrels all empty.`,
    ]);
  }
  return pick(rng, [
    `${name}, ${profession}, has died (${cause}). Aged ${age} years.`,
  ]);
}

/** Context that flavours a tantrum-onset line. The narrator picks the
 * variant pool by precedence: bereavement > rivalry > generic. All
 * fields optional — a colony with no graves and no grudges still
 * gets the generic pool, same as before. */
export interface TantrumOnsetContext {
  /** Name of a deceased partner whose grave the dwarf has been visiting. */
  lostPartnerName?: string;
  /** Name of a rival the dwarf has been feuding with (top live grudge). */
  rivalName?: string;
  /** True if the dwarf's HP recently dipped into the severe-wound band
   * and hasn't been treated back to full. */
  recentlyWounded?: boolean;
}

export function narrateTantrumOnset(rng: Rng, name: string, ctx: TantrumOnsetContext): string {
  // Precedence: a fresh grave outweighs a feud outweighs a generic
  // bad week. Each branch keeps the breakdown shape ("X has broken.")
  // for chronicle consistency, then attributes a cause.
  if (ctx.lostPartnerName) {
    return pick(rng, [
      `${name} has broken. They wander the halls muttering ${ctx.lostPartnerName}'s name.`,
      `${name} has broken — they have not slept since ${ctx.lostPartnerName} was laid to rest.`,
      `${name} has broken. The grief for ${ctx.lostPartnerName} has finally caught up with them.`,
    ]);
  }
  if (ctx.rivalName) {
    return pick(rng, [
      `${name} has broken. They throw a stool at the wall and curse ${ctx.rivalName}'s name.`,
      `${name} has broken. The feud with ${ctx.rivalName} has eaten what was left of their composure.`,
      `${name} has broken. They will not work in the same room as ${ctx.rivalName}.`,
    ]);
  }
  if (ctx.recentlyWounded) {
    return pick(rng, [
      `${name} has broken. The wounds from the last fight have not stopped aching.`,
      `${name} has broken. They sit at the hospital cot and refuse to rise.`,
    ]);
  }
  return pick(rng, [
    `${name} has broken. They wander the halls muttering, refusing all work.`,
    `${name} has broken. Nothing in the mountain pleases them today.`,
    `${name} has broken. They sit in a corner and stare at the wall.`,
  ]);
}

/** Context that flavours an obsession-onset line. When the fixation
 * matches the dwarf's strongest skill, lean into mastery framing;
 * otherwise the dwarf is taking up a new craft and the line says so. */
export interface ObsessionOnsetContext {
  /** The dwarf's currently-highest skill (any tier ≥ Skilled is worth
   * naming). Undefined for a brand-new dwarf with no rank advantage. */
  bestSkillId?: string;
  /** Human-friendly skill label for the fixation ("smithing" → "Smithing"). */
  skillLabel: string;
}

export function narrateObsessionOnset(rng: Rng, name: string, fixationSkillId: string, ctx: ObsessionOnsetContext): string {
  const skill = ctx.skillLabel;
  if (ctx.bestSkillId === fixationSkillId) {
    return pick(rng, [
      `${name} has fallen into a deep fixation with ${skill}. They will not leave the workshop for a week.`,
      `${name} has retreated into ${skill}. The other dwarves know to bring food and not to ask questions.`,
      `${name} has decided that everything they have ever made was a draft. ${skill} consumes them now.`,
    ]);
  }
  return pick(rng, [
    `${name} has fallen into a deep fixation with ${skill}. They are not to be reasoned with for a week.`,
    `${name} announces they will master ${skill} or break trying. The mountain has seen this before.`,
    `${name} has taken up ${skill} with a glint in their eye. A week of single-minded work follows.`,
  ]);
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
