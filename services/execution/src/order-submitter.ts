import { TradeIntent } from '@trading-council/contracts';
import { alpaca } from './alpaca.js';
import { pool } from './db.js';

export async function submitOrder(
  intentRow: Record<string, unknown>,
): Promise<void> {
  // Parse and validate the row against the TradeIntent schema
  let intent: TradeIntent;
  try {
    intent = TradeIntent.parse(intentRow);
  } catch (err) {
    const intentId = intentRow['intent_id'] ?? 'unknown';
    console.error(
      `[execution] order-submitter: schema validation failed for intent ${intentId}`,
      err,
    );
    try {
      await pool.query(
        `UPDATE trade_intents SET status = 'rejected' WHERE intent_id = $1`,
        [intentId],
      );
    } catch (dbErr) {
      console.error(
        `[execution] order-submitter: failed to reject intent ${intentId}`,
        dbErr,
      );
    }
    return;
  }

  // Paper mode guard — always use paper; refuse live
  const appMode = process.env['APP_MODE'];
  if (appMode && appMode !== 'paper') {
    console.warn(
      `[execution] order-submitter: APP_MODE=${appMode} is not 'paper'; refusing to switch to live. Staying on paper.`,
    );
  }

  try {
    const order = await alpaca.trading.orders.bracket({
      symbol: intent.ticker,
      side: intent.side,
      qty: Number(intent.qty),
      ...(intent.order_type === 'limit' && intent.limit_price != null
        ? { limitPrice: Number(intent.limit_price) }
        : {}),
      takeProfit: { limitPrice: intent.bracket.take_profit_price },
      stopLoss: { stopPrice: intent.bracket.stop_loss_price },
    });

    await pool.query(
      `INSERT INTO orders
         (intent_id, client_order_id, alpaca_order_id, ticker, side, qty, order_type, alpaca_status, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        intent.intent_id,
        intent.client_order_id,
        order.id,
        intent.ticker,
        intent.side,
        intent.qty,
        intent.order_type,
        order.status,
        JSON.stringify(order),
      ],
    );

    await pool.query(
      `UPDATE trade_intents SET status = 'submitted' WHERE intent_id = $1`,
      [intent.intent_id],
    );

    console.log(
      `[execution] order-submitter: submitted ${intent.ticker} ${intent.side} x${intent.qty} — alpaca_order_id=${order.id}`,
    );
  } catch (err) {
    console.error(
      `[execution] order-submitter: Alpaca error for intent ${intent.intent_id}`,
      err,
    );
    try {
      await pool.query(
        `UPDATE trade_intents SET status = 'failed' WHERE intent_id = $1`,
        [intent.intent_id],
      );
    } catch (dbErr) {
      console.error(
        `[execution] order-submitter: failed to mark intent ${intent.intent_id} as failed`,
        dbErr,
      );
    }
  }
}
