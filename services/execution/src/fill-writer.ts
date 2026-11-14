import type { streaming } from '@alpacahq/alpaca-trade-api';
type TradeUpdate = streaming.TradeUpdate;
import { alpaca } from './alpaca.js';
import { pool } from './db.js';
import { sendAlert, fmtUsd } from '@trading-council/alerts';
import { writePostMortem } from './post-mortem-writer.js';

/** exit_reason values the control-plane writes into trade_intents.bracket for exit intents. */
const EXIT_REASONS = new Set(['stop_loss', 'take_profit', 'time_exit', 'recovery', 'loss_reduction']);

async function recordExitPostMortem(
  clientOrderId: string,
  orderId: string,
  ticker: string,
  eventPrice: number,
  eventQty: number,
  orderFilledQty: number,
  orderAvgPrice: number,
  filledAt: Date,
): Promise<void> {
  try {
    const intent = await pool.query<{ intent_id: string; bracket: unknown }>(
      `SELECT ti.intent_id, ti.bracket
         FROM orders o JOIN trade_intents ti ON ti.intent_id = o.intent_id
        WHERE o.client_order_id = $1`,
      [clientOrderId],
    );
    const row = intent.rows[0];
    if (!row) return;
    const bracket = (typeof row.bracket === 'string' ? JSON.parse(row.bracket) : row.bracket) as
      | { exit_reason?: string }
      | null;
    const reason = bracket?.exit_reason;
    if (!reason || !EXIT_REASONS.has(reason)) return; // not one of our exit orders

    // The exit may fill in several events (partial_fill ... fill). Use the ORDER's cumulative
    // quantity and average price (from the broker's order object), not the last event's.
    const qty = orderFilledQty > 0 ? orderFilledQty : eventQty;
    const exitPrice = orderAvgPrice > 0 ? orderAvgPrice : eventPrice;

    // Entry price = volume-weighted average of buy fills since the previous sell of this ticker.
    // Exclude this order's own (partial) fills when finding "the previous sell".
    const entry = await pool.query<{ avg: string | null }>(
      `SELECT SUM(qty * fill_price) / NULLIF(SUM(qty), 0) AS avg
         FROM fills
        WHERE ticker = $1 AND side = 'buy' AND filled_at <= $2
          AND filled_at > COALESCE(
                (SELECT MAX(filled_at) FROM fills
                  WHERE ticker = $1 AND side = 'sell' AND filled_at < $2 AND order_id <> $3),
                '-infinity'::timestamptz)`,
      [ticker, filledAt, orderId],
    );
    const entryPrice = parseFloat(entry.rows[0]?.avg ?? '');
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      console.warn(`[execution] post-mortem: no entry fills found for ${ticker}, skipping`);
      return;
    }
    await writePostMortem({
      intentId: row.intent_id,
      ticker,
      entryPrice,
      exitPrice,
      qty,
      exitReason: reason as 'stop_loss' | 'take_profit' | 'time_exit' | 'recovery' | 'loss_reduction',
    });
  } catch (err) {
    console.error('[execution] fill-writer: post-mortem lookup failed (non-fatal)', err);
  }
}

export async function handleFill(update: TradeUpdate): Promise<void> {
  if (update.event !== 'fill' && update.event !== 'partial_fill') {
    return;
  }

  const clientOrderId: string =
    (update.order['clientOrderId'] as string | undefined) ??
    (update.order['client_order_id'] as string | undefined) ??
    '';

  // Find the order by client_order_id
  const orderResult = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM orders WHERE client_order_id = $1`,
    [clientOrderId],
  );

  if (orderResult.rows.length === 0) {
    console.warn(
      `[execution] fill-writer: order not found for client_order_id=${clientOrderId}, ignoring (non-council order)`,
    );
    return;
  }

  const orderId = orderResult.rows[0]!.order_id;
  const alpacaOrderId: string =
    (update.order['id'] as string | undefined) ?? '';
  const ticker: string =
    (update.order['symbol'] as string | undefined) ?? '';
  const side: string =
    (update.order['side'] as string | undefined) ?? '';
  const fillPrice = parseFloat(
    update.price ??
      (update.order['filledAvgPrice'] as string | undefined) ??
      (update.order['filled_avg_price'] as string | undefined) ??
      '0',
  );
  const fillQty = parseFloat(
    update.qty ??
      (update.order['filledQty'] as string | undefined) ??
      (update.order['filled_qty'] as string | undefined) ??
      '0',
  );
  const filledAt: Date =
    update.timestamp instanceof Date
      ? update.timestamp
      : new Date();

  await pool.query(
    `INSERT INTO fills
       (order_id, alpaca_order_id, ticker, side, qty, fill_price, filled_at, raw_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      alpacaOrderId,
      ticker,
      side,
      fillQty,
      fillPrice,
      filledAt,
      JSON.stringify(update),
    ],
  );

  // Fetch authoritative positions and account after fill
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

  // Asymmetric notional: sum notional_usd for open intents with bet_class='asymmetric'
  const asymResult = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(notional_usd), 0)::text AS total
     FROM trade_intents
     WHERE status IN ('pending', 'claimed', 'submitted')
       AND expires_at > NOW()
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
      'fill',
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
    [new Date(), navUsd, peakNav, drawdown, dailyPnl, 0, 'fill'],
  );

  // Alert on significant drawdown
  if (drawdown >= 0.05) {
    const pct = (drawdown * 100).toFixed(1);
    const level = drawdown >= 0.10 ? 'CRITICAL' : 'WARNING';
    await sendAlert(
      `[${level}] NAV Drawdown ${pct}%`,
      `Current NAV: $${navUsd.toFixed(2)}\nPeak NAV: $${peakNav.toFixed(2)}\nDrawdown: ${pct}%\nDaily PnL: ${fmtUsd(dailyPnl)}`,
    ).catch(() => {});
  }

  // Post-mortem: only for exit sells that we issued (control-plane tags them with
  // bracket.exit_reason). Entry fills and broker-side bracket children are not post-mortems.
  if (update.event === 'fill' && side === 'sell') {
    const orderQty = parseFloat(
      String(update.order['filledQty'] ?? update.order['filled_qty'] ?? ''),
    );
    const orderAvg = parseFloat(
      String(update.order['filledAvgPrice'] ?? update.order['filled_avg_price'] ?? ''),
    );
    await recordExitPostMortem(
      clientOrderId,
      orderId,
      ticker,
      fillPrice,
      fillQty,
      Number.isFinite(orderQty) ? orderQty : 0,
      Number.isFinite(orderAvg) ? orderAvg : 0,
      filledAt,
    );
  }

  console.log(
    `[execution] fill-writer: recorded ${update.event} for ${ticker} — qty=${fillQty} price=${fillPrice} nav=${navUsd}`,
  );
}
