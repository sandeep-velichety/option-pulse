/**
 * Whole-share sizing for stocks. Alpaca rejects fractional quantities on bracket orders
 * (stop-loss/take-profit legs) and on short sales, and every stock intent here is a bracket order.
 * Crypto is traded fractionally and does not use this.
 *
 * Rounds DOWN so the order never exceeds the sized notional (and the 5%-of-NAV hard cap).
 */
export interface WholeShares {
  qty: number;
  /** qty * price: the notional that will actually be traded (<= requested). */
  notionalUsd: number;
}

export function wholeShares(
  notionalUsd: number,
  price: number,
  /**
   * Hard per-position cap in USD (the risk gate's 5% of NAV). When the sized amount cannot buy a
   * single share but ONE share still fits under this cap, trade that one share rather than skip
   * the idea. Omit to disable the minimum-one-share rule.
   */
  maxNotionalUsd?: number,
): WholeShares {
  if (!(notionalUsd > 0) || !(price > 0) || !Number.isFinite(notionalUsd) || !Number.isFinite(price)) {
    return { qty: 0, notionalUsd: 0 };
  }
  // epsilon guards against 2.9999999999 from float division of an exact multiple
  let qty = Math.floor(notionalUsd / price + 1e-9);
  if (qty === 0 && maxNotionalUsd !== undefined && price <= maxNotionalUsd + 0.01) qty = 1;
  return { qty, notionalUsd: qty * price };
}
