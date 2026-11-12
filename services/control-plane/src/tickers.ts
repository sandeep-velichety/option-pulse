/**
 * Alpaca reports crypto positions without a slash ("BTCUSD") while orders, intents and
 * snapshots use "BTC/USD". Normalise to the intent format so position/intent/snapshot
 * lookups agree. Stock tickers pass through unchanged.
 */
export function toIntentTicker(symbol: string): string {
  if (!symbol.includes('/') && /^[A-Z]{2,6}USD$/.test(symbol) && symbol.length >= 6) {
    return `${symbol.slice(0, -3)}/USD`;
  }
  return symbol;
}

export const isCryptoTicker = (ticker: string): boolean => ticker.includes('/');

/** positions_snapshot.positions is JSONB: [{ticker, qty, avg_entry_price, ...}] (ticker like "BTCUSD"). */
export function parsePositionTickers(raw: unknown): string[] {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && parseFloat(String((p as Record<string, unknown>)['qty'] ?? '0')) > 0)
      .map((p) => toIntentTicker(String((p as Record<string, unknown>)['ticker'])));
  } catch {
    return [];
  }
}
