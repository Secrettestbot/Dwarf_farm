// Trade caravans (GDD §8.3) — scheduling, arrival, deal selection,
// and the broker's negotiation job. Extracted verbatim from sim.ts as
// part of the systems/ decomposition.

import { SimWorld } from "../world/simWorld";
import { EntityId } from "../ecs/world";
import { JobAssignment } from "../ecs/components";
import { TICKS_PER_DAY, seasonOf } from "../time";
import { effectsFor } from "../dwarves/traitEffects";
import { KINGDOMS, kingdomByName, REPUTATION_MIN, REPUTATION_MAX, REPUTATION_LOSS_PER_MISS, reputationPriceMultiplier, type KingdomProfile, type TradeImport } from "../trade/kingdoms";
import { awardSkillXp, clamp, dropJob } from "./shared";

// ---- Trade caravans (GDD §8.3) ---------------------------------------
//
// Once per in-game season a caravan arrives at the colony's Trade Depot
// (if one exists). The deal is computed from the colony's needs and
// the visiting kingdom's specialty: short on food, the caravan brings
// food; short on drink, drink; some kingdoms specialise in cloth /
// leather / tools, so when the Bronze Reach turns up they're more
// likely to be hauling textile-finished goods. Stone is the floor
// currency (early colonies have plenty), but a fortress with a mason
// or smelter trades blocks / bars instead because the kingdom's
// per-resource price multipliers reward it.
//
// Indirect control: the player never picks the trade. They influence
// outcomes by what the colony has on hand when the wagons roll up,
// shaped via the existing crafting / hauling / farming sliders. A
// pre-announcement event a few days before arrival names the kingdom
// and hints at cargo so the player has time to react.

const TRADE_INTERVAL_TICKS = TICKS_PER_DAY * 6; // four caravans per in-game year
const TRADE_BASE_GAIN = 50;
/** How early the outrider announces the next caravan, in ticks. ~3
 * in-game days gives the player time to redirect the colony toward
 * producing whatever surplus they'd like to trade with — bumping
 * crafting / farming / hauling sliders before the wagons arrive. */
const TRADE_PREANNOUNCE_LEAD = TICKS_PER_DAY * 3;

/** Goods the colony can offer to a visiting caravan, ordered by
 * preference: surplus accumulators first, raw resources last.
 * Caravans accept whichever offered good the colony has the most of
 * (above a minimum), so a fortress with a Mason's Workshop trades
 * blocks instead of stone. Per-resource pricing is kingdom-specific
 * — see kingdomByName in trade/kingdoms.ts. */
type TradeOffer = { resource: keyof import("../world/simWorld").Stockpile; price: number; min: number };
const TRADE_OFFERS: TradeOffer[] = [
  { resource: "cut_gems", price: 8, min: 3 },   // most valuable per unit
  { resource: "blocks", price: 4, min: 8 },
  { resource: "bars", price: 5, min: 6 },
  { resource: "tools", price: 7, min: 4 },
  { resource: "leather", price: 3, min: 8 },
  { resource: "cloth", price: 3, min: 8 },
  { resource: "pots", price: 2, min: 8 },
  { resource: "planks", price: 2, min: 12 },
  { resource: "gems", price: 4, min: 4 },
  { resource: "ore", price: 2, min: 15 },
  { resource: "stone", price: 1, min: 30 }, // legacy fallback
];

/** How long a caravan lingers at the depot once it arrives. The
 * trade transaction resolves on arrival; the visual trader stays for
 * a day's worth of in-game wandering so the player can actually see
 * the caravan in the world. */
const CARAVAN_STAY_TICKS = TICKS_PER_DAY;


function pickImportNeeded(sim: SimWorld, kingdom: KingdomProfile, exclude?: TradeImport): TradeImport | null {
  // Score each import by how badly the colony needs it. Higher score
  // wins. Kingdom preferences break ties — when food and drink are
  // equally low, a kingdom that prefers food wins out. excluded
  // import (already picked as primary) returns null so we don't
  // double-up on the same good.
  type Cand = { kind: TradeImport; score: number; pref: number };
  const candidates: Cand[] = [];
  const has = sim.stockpile as unknown as Record<string, number>;
  const lowFood = Math.max(0, 200 - (has["food"] ?? 0));
  const lowDrink = Math.max(0, 200 - (has["drink"] ?? 0));
  const tools = has["tools"] ?? 0;
  const ropeNeed = sim.research.completed.includes("rope_and_fibre")
    ? Math.max(0, 30 - (has["rope"] ?? 0))
    : 0;
  const clothNeed = sim.research.completed.includes("textile_craft")
    ? Math.max(0, 15 - (has["cloth"] ?? 0))
    : 0;
  const leatherNeed = Math.max(0, 15 - (has["leather"] ?? 0));
  const woodNeed = Math.max(0, 10 - (has["wood"] ?? 0));
  candidates.push({ kind: "food", score: lowFood, pref: kingdom.preferredImports.indexOf("food") });
  candidates.push({ kind: "drink", score: lowDrink, pref: kingdom.preferredImports.indexOf("drink") });
  candidates.push({ kind: "tools", score: Math.max(8, 30 - tools), pref: kingdom.preferredImports.indexOf("tools") });
  candidates.push({ kind: "rope", score: ropeNeed, pref: kingdom.preferredImports.indexOf("rope") });
  candidates.push({ kind: "cloth", score: clothNeed, pref: kingdom.preferredImports.indexOf("cloth") });
  candidates.push({ kind: "leather", score: leatherNeed, pref: kingdom.preferredImports.indexOf("leather") });
  candidates.push({ kind: "wood", score: woodNeed, pref: kingdom.preferredImports.indexOf("wood") });
  let best: Cand | null = null;
  for (const c of candidates) {
    if (c.score <= 0) continue;
    if (exclude !== undefined && c.kind === exclude) continue;
    if (!best) { best = c; continue; }
    if (c.score > best.score) { best = c; continue; }
    if (c.score === best.score) {
      // Tie-break: lower pref index (kingdom prefers it more) wins.
      // Negative pref (kingdom doesn't list it) loses to any non-negative.
      const aPref = best.pref < 0 ? 999 : best.pref;
      const bPref = c.pref < 0 ? 999 : c.pref;
      if (bPref < aPref) best = c;
    }
  }
  return best ? best.kind : null;
}

export function tradeSystem(sim: SimWorld): void {
  // Despawn any caravan whose stay has elapsed and write a sendoff
  // line to the chronicle so the player can see the visit end as
  // well as begin. Reputation drops if the broker never arrived.
  if (sim.caravanLeavesTick > 0 && sim.tick >= sim.caravanLeavesTick) {
    if (sim.caravanOrigin) {
      const missed = !sim.caravanDealComplete && sim.caravanBrokerId !== -1;
      const departureLine = sim.caravanDealComplete || sim.caravanBrokerId === -1
        ? `The caravan from ${sim.caravanOrigin} packs its wagons and rolls back out the gate.`
        : `The caravan from ${sim.caravanOrigin} leaves empty-handed — no broker reached the depot in time.`;
      sim.events.add(sim.tick, "social", departureLine);
      if (missed) {
        sim.tradeReputation[sim.caravanOrigin] = clamp(
          (sim.tradeReputation[sim.caravanOrigin] ?? 0) - REPUTATION_LOSS_PER_MISS,
          REPUTATION_MIN,
          REPUTATION_MAX,
        );
      }
    }
    sim.caravanLeavesTick = -1;
    sim.caravanOrigin = "";
    sim.caravanBrokerId = -1;
    sim.caravanDealResource = "";
    sim.caravanDealCost = 0;
    sim.caravanDealImport = "";
    sim.caravanDealGain = 0;
    sim.caravanDealImport2 = "";
    sim.caravanDealGain2 = 0;
    sim.caravanDealComplete = false;
  }

  // Pre-announcement: schedule the next caravan a few days out so the
  // player gets an outrider event and can prep production. Scheduled
  // once per TRADE_INTERVAL window, fires the actual arrival when
  // the schedule lands.
  if (sim.tick > 0 && sim.tick % TRADE_INTERVAL_TICKS === 0 && sim.caravanScheduledTick === -1) {
    if (sim.emergency.mode !== "lockdown") {
      const season = seasonOf(sim.tick + TRADE_PREANNOUNCE_LEAD);
      const arrivalChance =
        season === "winter" ? 0.3 :
        season === "summer" ? 1.0 :
        0.85;
      if (sim.aiRng.nextFloat() < arrivalChance) {
        const kingdom = KINGDOMS[sim.aiRng.nextRange(0, KINGDOMS.length)];
        sim.caravanScheduledTick = sim.tick + TRADE_PREANNOUNCE_LEAD;
        sim.caravanScheduledOrigin = kingdom.name;
        sim.caravanPreAnnounced = false;
      } else if (season === "winter") {
        sim.events.add(
          sim.tick,
          "social",
          `Heavy snow on the slopes — no caravan reaches the gate this season.`,
        );
      }
    }
  }

  // Outrider — fires immediately on the same tick the caravan was
  // scheduled (i.e., TRADE_PREANNOUNCE_LEAD ticks before arrival).
  // This is the player's "you have ~3 in-game days to prep" cue.
  if (
    sim.caravanScheduledTick > 0 &&
    !sim.caravanPreAnnounced &&
    sim.caravanScheduledOrigin
  ) {
    const kingdom = kingdomByName(sim.caravanScheduledOrigin);
    if (kingdom) {
      sim.events.add(
        sim.tick,
        "discovery",
        `An outrider rides ahead of a caravan from ${kingdom.name} — ${kingdom.hint} The wagons reach the gate in a few days.`,
      );
      sim.caravanPreAnnounced = true;
    }
  }

  // Caravan arrival — when the scheduled tick lands, actually park the
  // wagons at the depot and pick the deal.
  if (sim.caravanScheduledTick > 0 && sim.tick >= sim.caravanScheduledTick) {
    arriveCaravan(sim, sim.caravanScheduledOrigin);
    sim.caravanScheduledTick = -1;
    sim.caravanScheduledOrigin = "";
    sim.caravanPreAnnounced = false;
  }
}

function arriveCaravan(sim: SimWorld, originName: string): void {
  if (sim.emergency.mode === "lockdown") return;
  const kingdom = kingdomByName(originName);
  if (!kingdom) return;
  // Need an active Trade Depot.
  let depot: { cx: number; cy: number } | null = null;
  for (const b of sim.planner.blueprints) {
    if (b.kind === "trade_depot" && b.status === "complete") {
      depot = {
        cx: b.originX + Math.floor(b.width / 2),
        cy: b.originY + Math.floor(b.height / 2),
      };
      break;
    }
  }
  if (!depot) {
    sim.events.add(
      sim.tick,
      "social",
      `A caravan from ${kingdom.name} arrives at the gate, but no Trade Depot is open — the wagons turn back.`,
    );
    return;
  }
  sim.caravanX = depot.cx;
  sim.caravanY = depot.cy;
  sim.caravanLeavesTick = sim.tick + CARAVAN_STAY_TICKS;
  sim.caravanOrigin = kingdom.name;

  // Pick the offered good. Apply the kingdom's buys-multiplier and
  // reputation bonus so the same good fetches different prices from
  // different kingdoms, and from the same kingdom at different
  // reputation levels.
  const rep = sim.tradeReputation[kingdom.name] ?? 0;
  const repBonus = reputationPriceMultiplier(rep);
  // Pick the best-VALUE deal among goods the colony can spare, not the
  // first sellable one in list order — a colony sitting on fifty cut
  // gems shouldn't sell stone because stone cleared its threshold
  // first. Gross value = basket size × unit price × the kingdom's
  // per-resource multiplier; ties keep earlier (preference) order.
  let offer: TradeOffer | null = null;
  let offerKingdomPrice = 0;
  for (const o of TRADE_OFFERS) {
    if ((sim.stockpile[o.resource] ?? 0) < o.min) continue;
    const unitPrice = o.price * (kingdom.buys[o.resource] ?? 1.0) * repBonus;
    if (!offer || unitPrice * o.min > offerKingdomPrice * offer.min) {
      offer = o;
      offerKingdomPrice = unitPrice;
    }
  }
  if (!offer) {
    sim.events.add(
      sim.tick,
      "social",
      `A caravan from ${kingdom.name} arrives, but the colony has nothing worth trading. They depart empty-handed.`,
    );
    // Don't dock reputation here — the colony has no surplus, the
    // caravan still made the trip. Just no deal.
    return;
  }

  // Pick the broker — best Trading skill, tie-break by entity id.
  let bestBroker = -1;
  let bestSkill = -1;
  for (const id of sim.dwarf.entities) {
    const dw = sim.dwarf.get(id);
    if (!dw) continue;
    const skill = dw.skills.trading ?? 1;
    if (skill > bestSkill || (skill === bestSkill && id < bestBroker)) {
      bestBroker = id;
      bestSkill = skill;
    }
  }
  const brokerDw = bestBroker !== -1 ? sim.dwarf.get(bestBroker) : undefined;
  const tradeBonus = brokerDw ? effectsFor(brokerDw.traitIds).tradeBonus : 0;
  const brokerBonus = (1 + Math.max(0, bestSkill - 1) * 0.04) * (1 + tradeBonus);

  // The basket. Spend `min` units of the offered good and split the
  // resulting gain across one or two imports — primary is whatever
  // the colony's lowest staple is (weighted by kingdom preference).
  const cost = offer.min;
  const grossValue = cost * offerKingdomPrice;
  const totalGain = Math.round(grossValue * brokerBonus * (TRADE_BASE_GAIN / 30));
  const primary = pickImportNeeded(sim, kingdom);
  if (primary === null) {
    sim.events.add(
      sim.tick,
      "social",
      `A caravan from ${kingdom.name} arrives, but the colony needs nothing they're carrying. They depart with their goods.`,
    );
    return;
  }
  const secondary = pickImportNeeded(sim, kingdom, primary);
  // 70/30 split when there's a secondary, else 100% primary.
  const primaryGain = secondary === null ? totalGain : Math.round(totalGain * 0.7);
  const secondaryGain = secondary === null ? 0 : Math.max(1, totalGain - primaryGain);

  sim.caravanBrokerId = bestBroker;
  sim.caravanDealResource = offer.resource;
  sim.caravanDealCost = cost;
  sim.caravanDealImport = primary;
  sim.caravanDealGain = primaryGain;
  sim.caravanDealImport2 = secondary ?? "";
  sim.caravanDealGain2 = secondaryGain;
  sim.caravanDealComplete = false;
  const brokerName = bestBroker !== -1 ? sim.dwarf.get(bestBroker)?.name ?? "the broker" : "the broker";
  const basketStr = secondary
    ? `${primaryGain} ${primary} + ${secondaryGain} ${secondary}`
    : `${primaryGain} ${primary}`;
  sim.events.add(
    sim.tick,
    "discovery",
    `A caravan from ${kingdom.name} arrives at the Trade Depot. ${brokerName} sets out to negotiate ${basketStr} for ${cost} ${offer.resource}.`,
    { x: depot.cx, y: depot.cy },
  );
}


/** Walk to the caravan depot and close the trade. The broker's
 * job — set when a caravan arrives, computed in tradeSystem — is
 * applied here once the broker is at (or adjacent to) the depot
 * tile. NEGOTIATE_TICKS keeps the broker on site briefly so the
 * exchange is visible, then the counters update + a chronicle
 * line fires. Bails if the caravan despawns mid-walk. */
const NEGOTIATE_TICKS = 60; // one in-game hour at the table
export function progressTrade(sim: SimWorld, e: EntityId, job: JobAssignment, pos: { x: number; y: number }): void {
  // Caravan packed up while we were walking — no deal.
  if (sim.caravanLeavesTick <= 0 || sim.caravanDealComplete) {
    dropJob(sim, e);
    return;
  }
  const dx = Math.abs(pos.x - sim.caravanX);
  const dy = Math.abs(pos.y - sim.caravanY);
  // Still walking — wait until adjacent (or on) the depot tile.
  if (dx > 1 || dy > 1) return;
  job.progress++;
  if (job.progress < NEGOTIATE_TICKS) return;
  // Negotiation finished — apply the deal we cached at arrival.
  // Multi-good baskets credit both the primary and secondary import.
  const stockpile = sim.stockpile as unknown as Record<string, number>;
  // The colony may have spent some of the offered goods between the
  // caravan's arrival and the broker closing the deal — clamp the
  // payment to what's actually on hand so the counter can't go negative.
  const paid = Math.min(sim.caravanDealCost, Math.max(0, stockpile[sim.caravanDealResource] ?? 0));
  stockpile[sim.caravanDealResource] = (stockpile[sim.caravanDealResource] ?? 0) - paid;
  stockpile[sim.caravanDealImport] = (stockpile[sim.caravanDealImport] ?? 0) + sim.caravanDealGain;
  if (sim.caravanDealImport2 && sim.caravanDealGain2 > 0) {
    stockpile[sim.caravanDealImport2] = (stockpile[sim.caravanDealImport2] ?? 0) + sim.caravanDealGain2;
  }
  sim.caravanDealComplete = true;
  // Successful deal raises the kingdom's reputation, capped so a
  // long-running fortress doesn't end up with infinitely good prices.
  if (sim.caravanOrigin) {
    const REP_MIN = -10, REP_MAX = 20, REP_GAIN = 2;
    sim.tradeReputation[sim.caravanOrigin] = Math.min(
      REP_MAX,
      Math.max(REP_MIN, (sim.tradeReputation[sim.caravanOrigin] ?? 0) + REP_GAIN),
    );
  }
  awardSkillXp(sim, e, "trading", 1);
  const dw = sim.dwarf.get(e);
  const brokerName = dw?.name ?? "the broker";
  const basketStr = sim.caravanDealImport2 && sim.caravanDealGain2 > 0
    ? `${sim.caravanDealGain} ${sim.caravanDealImport} + ${sim.caravanDealGain2} ${sim.caravanDealImport2}`
    : `${sim.caravanDealGain} ${sim.caravanDealImport}`;
  sim.events.add(
    sim.tick,
    "social",
    `${brokerName} closes the deal at the Trade Depot — ${basketStr} for ${paid} ${sim.caravanDealResource}.`,
    { x: sim.caravanX, y: sim.caravanY },
  );
  sim.dwarf.get(e)!.lastJobTick = sim.tick;
  dropJob(sim, e);
}

