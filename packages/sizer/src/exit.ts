/**
 * Deterministic exit rule for positions that have no broker-side bracket
 * (crypto: Alpaca paper does not support bracket orders for crypto, so without
 * this a crypto position is never closed).
 *
 * Pure function — no I/O, no clock reads (caller passes `now`). Long-only: the
 * system does not short crypto.
 */

export type ExitReason = "stop_loss" | "take_profit" | "time_exit";

export interface ExitConfig {
  /** Stop distance used when the entry intent has no usable stop. */
  defaultStopFraction: number;
  /** Intent-derived stops are clamped into [minStopFraction, maxStopFraction]:
   *  stock-style ATR brackets (~1.5%) are far too tight for crypto. */
  minStopFraction: number;
  maxStopFraction: number;
  defaultTakeProfitFraction: number;
  minTakeProfitFraction: number;
  maxTakeProfitFraction: number;
  /** Hold limit when the entry thesis has no horizon. */
  defaultMaxHoldDays: number;
  /** Extra days beyond the thesis horizon before the time exit fires. */
  holdGraceDays: number;
}

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  defaultStopFraction: 0.08,
  minStopFraction: 0.05,
  maxStopFraction: 0.15,
  defaultTakeProfitFraction: 0.2,
  minTakeProfitFraction: 0.1,
  maxTakeProfitFraction: 0.4,
  defaultMaxHoldDays: 14,
  holdGraceDays: 1,
};

export interface ExitInput {
  /** Average entry price of the open position. */
  entryPrice: number;
  lastPrice: number;
  /** Absolute stop/take-profit from the entry intent's bracket, if known. */
  intentStopPrice?: number | null;
  intentTakeProfitPrice?: number | null;
  /** When the position was opened (entry intent creation), if known. */
  openedAt?: Date | null;
  /** Thesis horizon in days from the Allocator, if known. */
  horizonDays?: number | null;
  now: Date;
}

export interface ExitDecision {
  exit: boolean;
  reason: ExitReason | null;
  stopPrice: number;
  takeProfitPrice: number;
  detail: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const valid = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

export function evaluateExit(
  input: ExitInput,
  config: ExitConfig = DEFAULT_EXIT_CONFIG,
): ExitDecision {
  const { entryPrice, lastPrice, now } = input;
  if (!valid(entryPrice) || !valid(lastPrice)) {
    return {
      exit: false,
      reason: null,
      stopPrice: 0,
      takeProfitPrice: 0,
      detail: `invalid prices entry=${entryPrice} last=${lastPrice} — no action`,
    };
  }

  const intentStopFraction =
    valid(input.intentStopPrice) && input.intentStopPrice < entryPrice
      ? (entryPrice - input.intentStopPrice) / entryPrice
      : config.defaultStopFraction;
  const stopFraction = clamp(intentStopFraction, config.minStopFraction, config.maxStopFraction);

  const intentTpFraction =
    valid(input.intentTakeProfitPrice) && input.intentTakeProfitPrice > entryPrice
      ? (input.intentTakeProfitPrice - entryPrice) / entryPrice
      : config.defaultTakeProfitFraction;
  const tpFraction = clamp(
    intentTpFraction,
    config.minTakeProfitFraction,
    config.maxTakeProfitFraction,
  );

  const stopPrice = entryPrice * (1 - stopFraction);
  const takeProfitPrice = entryPrice * (1 + tpFraction);
  const pct = ((lastPrice / entryPrice - 1) * 100).toFixed(2);

  // Stop-loss wins over everything else.
  if (lastPrice <= stopPrice) {
    return {
      exit: true,
      reason: "stop_loss",
      stopPrice,
      takeProfitPrice,
      detail: `last=${lastPrice} <= stop=${stopPrice.toFixed(2)} (${pct}% vs entry ${entryPrice})`,
    };
  }
  if (lastPrice >= takeProfitPrice) {
    return {
      exit: true,
      reason: "take_profit",
      stopPrice,
      takeProfitPrice,
      detail: `last=${lastPrice} >= target=${takeProfitPrice.toFixed(2)} (${pct}% vs entry ${entryPrice})`,
    };
  }

  if (input.openedAt instanceof Date && !Number.isNaN(input.openedAt.getTime())) {
    const maxHold =
      (valid(input.horizonDays) ? input.horizonDays : config.defaultMaxHoldDays) +
      config.holdGraceDays;
    const heldDays = (now.getTime() - input.openedAt.getTime()) / 86_400_000;
    if (heldDays >= maxHold) {
      return {
        exit: true,
        reason: "time_exit",
        stopPrice,
        takeProfitPrice,
        detail: `held ${heldDays.toFixed(1)}d >= limit ${maxHold}d (${pct}% vs entry ${entryPrice})`,
      };
    }
  }

  return {
    exit: false,
    reason: null,
    stopPrice,
    takeProfitPrice,
    detail: `hold: ${pct}% vs entry; stop=${stopPrice.toFixed(2)} target=${takeProfitPrice.toFixed(2)}`,
  };
}
