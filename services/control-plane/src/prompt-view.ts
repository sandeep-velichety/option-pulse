import type { MarketSnapshot } from '@trading-council/contracts';

/**
 * How the market regime is shown to the LLMs.
 *
 * When the VIX feed is not configured or failed, the snapshot carries vix=0 with
 * vix_stale_days=999. Shown raw, the Adversary read that as corrupted macro data and
 * vetoed nearly every trade as "regime_change". A missing feed is a data gap, not a
 * market signal, so say exactly that instead of presenting a fake zero.
 */
export function regimeForPrompt(snapshot: MarketSnapshot): Record<string, unknown> {
  const r = snapshot.regime;
  if (r.vix_stale_days >= 999 || !(r.vix > 0)) {
    return {
      vix: null,
      vix_available: false,
      note:
        'VIX data is unavailable (feed not configured or failed). This is a data gap, NOT a market ' +
        'signal: do not treat it as risk-off, as corrupted macro context, or as a flaw in the thesis.',
    };
  }
  return { vix: r.vix, vix_available: true, vix_as_of: r.vix_as_of, vix_stale_days: r.vix_stale_days };
}
