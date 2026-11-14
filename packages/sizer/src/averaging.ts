/**
 * Position manager for long crypto positions that have no broker-side stop/target:
 * decides whether to HOLD, ADD (cost-average) or EXIT — in one place, so averaging and
 * stops cannot contradict each other.
 *
 * Averaging is conditional, never mechanical. A price drop alone is not a reason to buy
 * more: an add only happens when there is a real discount AND the sell-off is not still
 * accelerating AND the price has stopped making new lows AND the new average is within
 * reach of a plausible rebound AND portfolio risk limits allow it. Otherwise the result is
 * HOLD with the list of blockers, so every skipped add is explainable.
 *
 * Exits target the LOWERED average cost: after an add the break-even moves down, so the
 * position can be closed below the original entry price at a profit (recovery) or a reduced
 * loss (loss_reduction, when a recovery stalls). Long-only. Pure: no I/O, no clock reads.
 */

export type ManageReason =
  | "take_profit"
  | "recovery"
  | "loss_reduction"
  | "stop_loss"
  | "time_exit"
  | "averaging_add";

export interface ManageConfig {
  // --- averaging ladder ---
  maxAdds: number; // max additional tranches after the opening buy
  addStepFraction: number; // each add needs price this far below the reference (last add or avg cost)
  trancheNavFraction: number; // size of each add, as a fraction of NAV
  maxPositionNavFraction: number; // hard cap: position cost basis incl. the add (matches the 5% gate cap)
  // --- "does it make sense?" filters ---
  maxDayDropFraction: number; // do not add into a day that is down more than this
  volumeSpikeZ: number; // ... or a down day on volume at/above this z-score (distribution)
  stabiliseLookback: number; // closes examined for "still making new lows"
  stabiliseBounceFraction: number; // price must be at least this far above the lowest recent close
  maxReboundToBreakeven: number; // new average may be at most this far above the price (else out of reach)
  // --- exits ---
  takeProfitFraction: number; // default target above average cost (clamped to the ranges below)
  minTakeProfitFraction: number;
  maxTakeProfitFraction: number;
  recoveryProfitFraction: number; // after an add: exit once price is this far ABOVE the lowered average
  lossReductionFraction: number; // after an add: accept a loss up to this fraction below average...
  stallDays: number; // ...once this many days have passed since the last add without recovery
  maxLossNavFraction: number; // hard stop: unrealised loss on the position, as a fraction of NAV
  hardStopFraction: number; // price stop while the ladder still has rungs: this far below the reference
  finalStopFraction: number; // tighter stop once the ladder is used up (no more averaging to rely on)
  underwaterMaxHoldDays: number; // time exit for a losing position
  defaultMaxHoldDays: number; // time exit for a profitable position when the thesis horizon is unknown
  holdGraceDays: number;
  // --- portfolio risk limits (mirror the risk gate) ---
  maxDrawdownFraction: number;
  dailyLossLimitFraction: number;
  blockOnHaltLevel: number;
}

export const DEFAULT_MANAGE_CONFIG: ManageConfig = {
  maxAdds: 2,
  addStepFraction: 0.07,
  trancheNavFraction: 0.01,
  maxPositionNavFraction: 0.05,
  maxDayDropFraction: 0.03,
  volumeSpikeZ: 3,
  stabiliseLookback: 7,
  stabiliseBounceFraction: 0.01,
  maxReboundToBreakeven: 0.12,
  takeProfitFraction: 0.2,
  minTakeProfitFraction: 0.1,
  maxTakeProfitFraction: 0.4,
  recoveryProfitFraction: 0.005,
  lossReductionFraction: 0.03,
  stallDays: 10,
  maxLossNavFraction: 0.03,
  hardStopFraction: 0.2,
  finalStopFraction: 0.1,
  underwaterMaxHoldDays: 45,
  defaultMaxHoldDays: 14,
  holdGraceDays: 1,
  maxDrawdownFraction: 0.1,
  dailyLossLimitFraction: 0.02,
  blockOnHaltLevel: 2,
};

export interface ManageInput {
  /** Average cost of the whole position. */
  entryPrice: number;
  lastPrice: number;
  qty: number;
  navUsd: number;
  haltLevel: number;
  drawdownFraction: number;
  dailyPnlUsd: number;
  /** Tranches added after the opening buy. */
  adds: number;
  /** Price at the most recent add (null if there has been none). */
  lastAddPrice?: number | null;
  lastAddAt?: Date | null;
  /** When the position was opened, and the thesis horizon in days, if known. */
  openedAt?: Date | null;
  horizonDays?: number | null;
  /** Absolute take-profit from the opening intent, if known. */
  intentTakeProfitPrice?: number | null;
  // market context (from the latest snapshot)
  prevClose?: number | null;
  volumeZ?: number | null;
  /** Daily closes oldest → newest; the last element may be today's partial bar. */
  recentCloses?: ReadonlyArray<number>;
  now: Date;
}

export interface ManageResult {
  action: "hold" | "add" | "exit";
  reason: ManageReason | null;
  detail: string;
  /** For action 'add': USD to buy. */
  notionalUsd?: number;
  /** For action 'add': the average cost after the add. */
  newAvgEntry?: number;
  /** Why an add was NOT made (only filled when a discount existed but something said no). */
  blockers: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function managePosition(
  i: ManageInput,
  cfg: ManageConfig = DEFAULT_MANAGE_CONFIG,
): ManageResult {
  const none: string[] = [];
  const { entryPrice: avg, lastPrice: last, qty, navUsd: nav, now } = i;

  if (!ok(avg) || !ok(last) || !ok(qty)) {
    return { action: "hold", reason: null, detail: `invalid inputs avg=${avg} last=${last} qty=${qty} — no action`, blockers: none };
  }

  const vsAvg = last / avg - 1;
  const lossUsd = Math.max(0, (avg - last) * qty);
  const heldDays =
    i.openedAt instanceof Date && !Number.isNaN(i.openedAt.getTime())
      ? (now.getTime() - i.openedAt.getTime()) / 86_400_000
      : null;
  const adds = Math.max(0, i.adds);
  const refPrice = ok(i.lastAddPrice) ? i.lastAddPrice : avg;

  // 1. Take profit.
  const tpFrac = clamp(
    ok(i.intentTakeProfitPrice) && i.intentTakeProfitPrice > avg
      ? i.intentTakeProfitPrice / avg - 1
      : cfg.takeProfitFraction,
    cfg.minTakeProfitFraction,
    cfg.maxTakeProfitFraction,
  );
  if (last >= avg * (1 + tpFrac)) {
    return { action: "exit", reason: "take_profit", detail: `price ${last} is ${pct(vsAvg)} vs avg cost ${avg.toFixed(2)} (target +${pct(tpFrac)})`, blockers: none };
  }

  // 2. Recovery: after an add the break-even is lower, so a smaller bounce gets us out.
  if (adds > 0 && last >= avg * (1 + cfg.recoveryProfitFraction)) {
    return { action: "exit", reason: "recovery", detail: `recovered to ${pct(vsAvg)} vs LOWERED avg cost ${avg.toFixed(2)} after ${adds} add(s) — selling below the original entry for a profit`, blockers: none };
  }

  // 3. Loss reduction: a stalled recovery — take the smaller loss rather than wait.
  if (adds > 0 && i.lastAddAt instanceof Date) {
    const sinceAdd = (now.getTime() - i.lastAddAt.getTime()) / 86_400_000;
    if (sinceAdd >= cfg.stallDays && last >= avg * (1 - cfg.lossReductionFraction)) {
      return { action: "exit", reason: "loss_reduction", detail: `recovery stalled ${sinceAdd.toFixed(1)}d after last add; price is ${pct(vsAvg)} vs lowered avg cost — closing to cut the loss`, blockers: none };
    }
  }

  // 4. Hard stops.
  if (nav > 0 && lossUsd >= cfg.maxLossNavFraction * nav) {
    return { action: "exit", reason: "stop_loss", detail: `unrealised loss $${lossUsd.toFixed(0)} >= ${pct(cfg.maxLossNavFraction)} of NAV ($${(cfg.maxLossNavFraction * nav).toFixed(0)})`, blockers: none };
  }
  // Price stop, measured below the reference (the last add, else the average cost). It applies
  // whether or not an add is still possible, so a position that cannot be averaged (over the cap,
  // filters blocking, dry-run) is never left without a price stop. Averaging rungs sit at -7%/-14%,
  // above the -20% stop, so the ladder still has room to work before the stop is reached.
  const stopFrac = adds >= cfg.maxAdds ? cfg.finalStopFraction : cfg.hardStopFraction;
  if (last <= refPrice * (1 - stopFrac)) {
    return { action: "exit", reason: "stop_loss", detail: `price ${last} is ${pct(last / refPrice - 1)} below the ${ok(i.lastAddPrice) ? "last add" : "average cost"} ${refPrice.toFixed(2)} (stop at -${pct(stopFrac)}${adds >= cfg.maxAdds ? ", ladder exhausted" : ""})`, blockers: none };
  }

  // 5. Time exit. A loser gets a long leash (it is being averaged); a winner follows the thesis horizon.
  if (heldDays !== null) {
    const limit =
      vsAvg < 0
        ? cfg.underwaterMaxHoldDays
        : (ok(i.horizonDays) ? i.horizonDays : cfg.defaultMaxHoldDays) + cfg.holdGraceDays;
    if (heldDays >= limit) {
      return { action: "exit", reason: "time_exit", detail: `held ${heldDays.toFixed(1)}d >= ${limit}d limit (${pct(vsAvg)} vs avg cost)`, blockers: none };
    }
  }

  // 6. Should we cost-average? Only when it makes sense.
  const discountOk = last <= refPrice * (1 - cfg.addStepFraction);
  if (!discountOk) {
    return { action: "hold", reason: null, detail: `hold: ${pct(vsAvg)} vs avg cost ${avg.toFixed(2)}; add needs price <= ${(refPrice * (1 - cfg.addStepFraction)).toFixed(2)} (${pct(-cfg.addStepFraction)} below ${ok(i.lastAddPrice) ? "last add" : "avg cost"})`, blockers: none };
  }

  const blockers: string[] = [];
  if (adds >= cfg.maxAdds) blockers.push(`ladder exhausted (${adds}/${cfg.maxAdds} adds)`);
  if (i.haltLevel >= cfg.blockOnHaltLevel) blockers.push(`circuit breaker level ${i.haltLevel}`);
  if (i.drawdownFraction >= cfg.maxDrawdownFraction) blockers.push(`portfolio drawdown ${pct(i.drawdownFraction)} >= ${pct(cfg.maxDrawdownFraction)}`);
  if (nav > 0 && i.dailyPnlUsd < -cfg.dailyLossLimitFraction * nav) blockers.push(`daily loss limit hit (${i.dailyPnlUsd.toFixed(0)})`);

  const tranche = nav * cfg.trancheNavFraction;
  if (!(tranche > 0)) blockers.push("no NAV to size a tranche");
  if (nav > 0 && qty * avg + tranche > cfg.maxPositionNavFraction * nav) {
    blockers.push(`position cost cap: $${(qty * avg).toFixed(0)} + $${tranche.toFixed(0)} > ${pct(cfg.maxPositionNavFraction)} of NAV`);
  }

  const dayChange = ok(i.prevClose) ? last / i.prevClose - 1 : 0;
  if (dayChange < -cfg.maxDayDropFraction) blockers.push(`sell-off still accelerating: ${pct(dayChange)} today`);
  if (typeof i.volumeZ === "number" && i.volumeZ >= cfg.volumeSpikeZ && dayChange < 0) {
    blockers.push(`high-volume down day (volume z=${i.volumeZ.toFixed(1)}) — distribution, not a bottom`);
  }

  const closes = i.recentCloses ?? [];
  if (closes.length < cfg.stabiliseLookback) {
    blockers.push(`insufficient history (${closes.length}/${cfg.stabiliseLookback} closes)`);
  } else {
    const lowest = Math.min(...closes.slice(-cfg.stabiliseLookback));
    if (last < lowest * (1 + cfg.stabiliseBounceFraction)) {
      blockers.push(`still making new lows (price ${last} within ${pct(cfg.stabiliseBounceFraction)} of the ${cfg.stabiliseLookback}-day low ${lowest.toFixed(2)})`);
    }
  }

  let newAvg: number | undefined;
  if (tranche > 0) {
    newAvg = (qty * avg + tranche) / (qty + tranche / last);
    const rebound = newAvg / last - 1;
    if (rebound > cfg.maxReboundToBreakeven) {
      blockers.push(`break-even out of reach: needs +${pct(rebound)} even after averaging (max ${pct(cfg.maxReboundToBreakeven)})`);
    }
  }

  if (blockers.length > 0) {
    return { action: "hold", reason: null, detail: `hold: ${pct(vsAvg)} vs avg cost; add declined`, blockers };
  }

  return {
    action: "add",
    reason: "averaging_add",
    notionalUsd: tranche,
    newAvgEntry: newAvg,
    detail: `add #${adds + 1}/${cfg.maxAdds}: $${tranche.toFixed(0)} at ${last} (${pct(vsAvg)} vs avg cost); lowers average cost ${avg.toFixed(2)} -> ${newAvg!.toFixed(2)}; sell-off has stabilised`,
    blockers: none,
  };
}
