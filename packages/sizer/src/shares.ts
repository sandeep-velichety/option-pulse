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

export function wholeShares(notionalUsd: number, price: number): WholeShares {
  if (!(notionalUsd > 0) || !(price > 0) || !Number.isFinite(notionalUsd) || !Number.isFinite(price)) {
    return { qty: 0, notionalUsd: 0 };
  }
  // epsilon guards against 2.9999999999 from float division of an exact multiple
  const qty = Math.floor(notionalUsd / price + 1e-9);
  return { qty, notionalUsd: qty * price };
}
