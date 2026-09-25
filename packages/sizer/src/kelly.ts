import type { StockRecommendation } from "@trading-council/contracts";

export interface SizerOutput {
  nav_at_decision: number;
  /** Effective edge over the holding period, as a decimal (post conviction-scaling) */
  edge: number;
  /** Variance over the holding period, scaled from annualized vol */
  variance: number;
  /** Raw Kelly fraction (f*); null when variance is zero */
  kelly_f_raw: number | null;
  /** Final fraction of NAV to deploy; clamped to [0, 0.05] */
  kelly_f_capped: number;
  cap_applied: "kelly_cap" | "floor" | "asym_flat_cap" | "asym_aggregate_cap" | "none";
  /** Dollar notional = kelly_f_capped × nav */
  notional_usd: number;
}

const QUARTER_KELLY = 0.25;
const CORE_NAV_CAP = 0.05;
const ASYM_PER_POSITION_CAP = 0.01;
const ASYM_AGGREGATE_CAP = 0.05;
const TRADING_DAYS_PER_YEAR = 252;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Pure function. Computes fractional Kelly position sizing for a
 * specialist recommendation after the council has weighed in.
 *
 * @param recommendation  The validated specialist output.
 * @param convictionAdjustment  Allocator's nudge from CouncilVerdict ([-0.5, 0.5]).
 * @param nav  Current portfolio NAV in USD.
 * @param asymmetricNotionalOpen  Total notional already open in asymmetric positions.
 */
export function kellySizer(
  recommendation: StockRecommendation,
  convictionAdjustment: number,
  nav: number,
  asymmetricNotionalOpen: number,
): SizerOutput {
  if (nav <= 0) throw new Error(`nav must be positive, got ${nav}`);
  if (recommendation.abstain || recommendation.direction === "flat") {
    throw new Error(
      `kellySizer must not be called on abstain/flat recommendations`,
    );
  }

  const adjustedConviction = clamp(
    recommendation.conviction + convictionAdjustment,
    0,
    1,
  );

  // Edge is the expected return over horizon_days, conviction-weighted.
  const edge = (recommendation.est_edge_bps / 10_000) * adjustedConviction;

  // Scale annualized vol² to the trade's holding period.
  const variance =
    recommendation.est_vol ** 2 *
    (recommendation.horizon_days / TRADING_DAYS_PER_YEAR);

  const kelly_f_raw = variance > 0 ? edge / variance : null;

  let kelly_f_capped: number;
  let cap_applied: SizerOutput["cap_applied"];

  if (recommendation.bet_class === "asymmetric") {
    const remainingBudget = ASYM_AGGREGATE_CAP * nav - asymmetricNotionalOpen;
    if (remainingBudget <= 0) {
      kelly_f_capped = 0;
      cap_applied = "asym_aggregate_cap";
    } else {
      const maxFraction = Math.min(
        ASYM_PER_POSITION_CAP,
        remainingBudget / nav,
      );
      kelly_f_capped = maxFraction;
      // If the remaining budget can't fund a full 1% position, the aggregate
      // cap is the binding constraint even though we're still sizing > 0.
      cap_applied =
        remainingBudget >= ASYM_PER_POSITION_CAP * nav
          ? "asym_flat_cap"
          : "asym_aggregate_cap";
    }
  } else {
    // core bet class — quarter-Kelly, capped at 5% NAV
    if (kelly_f_raw === null || kelly_f_raw <= 0) {
      kelly_f_capped = 0;
      cap_applied = "floor";
    } else {
      const quarterKelly = kelly_f_raw * QUARTER_KELLY;
      if (quarterKelly > CORE_NAV_CAP) {
        kelly_f_capped = CORE_NAV_CAP;
        cap_applied = "kelly_cap";
      } else {
        kelly_f_capped = quarterKelly;
        cap_applied = "none";
      }
    }
  }

  return {
    nav_at_decision: nav,
    edge,
    variance,
    kelly_f_raw,
    kelly_f_capped,
    cap_applied,
    notional_usd: kelly_f_capped * nav,
  };
}
