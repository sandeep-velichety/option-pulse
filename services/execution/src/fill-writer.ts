import type { streaming } from '@alpacahq/alpaca-trade-api';
type TradeUpdate = streaming.TradeUpdate;
import { alpaca } from './alpaca.js';
import { pool } from './db.js';

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

  console.log(
    `[execution] fill-writer: recorded ${update.event} for ${ticker} — qty=${fillQty} price=${fillPrice} nav=${navUsd}`,
  );
}
