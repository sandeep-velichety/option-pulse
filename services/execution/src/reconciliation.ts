import { alpaca } from './alpaca.js';
import { pool } from './db.js';

export async function runEodReconciliation(): Promise<void> {
  console.log('[execution] reconciliation: starting EOD reconciliation');

  try {
    const [positions, account] = await Promise.all([
      alpaca.trading.positions.getAllOpenPositions(),
      alpaca.trading.account.getAccount(),
    ]);

    const positionsJson = positions.map((p) => ({
      ticker: p.symbol,
      qty: p.qty,
      avg_entry_price: p.avgEntryPrice,
      market_value: p.marketValue,
      unrealized_pnl: p.unrealizedPl,
    }));

    const totalMarketValue = positions.reduce(
      (sum, p) => sum + parseFloat(p.marketValue),
      0,
    );

    // Asymmetric notional: open intents with bet_class='asymmetric'
    const asymResult = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(notional_usd), 0)::text AS total
       FROM trade_intents
       WHERE status IN ('pending', 'claimed', 'submitted')
         AND bet_class = 'asymmetric'`,
    );
    const asymmetricNotional = parseFloat(
      asymResult.rows[0]?.total ?? '0',
    );

    await pool.query(
      `INSERT INTO positions_snapshot
         (as_of, positions, total_market_value_usd, asymmetric_notional_usd, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        new Date(),
        JSON.stringify(positionsJson),
        totalMarketValue,
        asymmetricNotional,
        'eod_reconcile',
      ],
    );

    // NAV history
    const navUsd = parseFloat(account.equity ?? '0');

    const peakResult = await pool.query<{ peak_nav_usd: string }>(
      `SELECT peak_nav_usd FROM nav_history ORDER BY as_of DESC LIMIT 1`,
    );
    const lastPeak = peakResult.rows[0]
      ? parseFloat(peakResult.rows[0].peak_nav_usd)
      : navUsd;
    const peakNav = Math.max(navUsd, lastPeak);
    const drawdown = peakNav > 0 ? 1 - navUsd / peakNav : 0;
    const dailyPnl =
      parseFloat(account.equity ?? '0') -
      parseFloat(account.lastEquity ?? account.equity ?? '0');

    await pool.query(
      `INSERT INTO nav_history
         (as_of, nav_usd, peak_nav_usd, drawdown_fraction, daily_pnl_usd, halt_level, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [new Date(), navUsd, peakNav, drawdown, dailyPnl, 0, 'eod_reconcile'],
    );

    // Mark expired intents as rejected
    const expiredResult = await pool.query<{ count: string }>(
      `UPDATE trade_intents
       SET status = 'rejected'
       WHERE status IN ('pending', 'claimed') AND expires_at < NOW()
       RETURNING intent_id`,
    );

    console.log(
      `[execution] reconciliation: complete — ` +
        `positions=${positions.length} nav=${navUsd} ` +
        `drawdown=${(drawdown * 100).toFixed(2)}% ` +
        `expired_intents_rejected=${expiredResult.rowCount ?? 0}`,
    );
  } catch (err) {
    console.error('[execution] reconciliation: error', err);
  }
}
