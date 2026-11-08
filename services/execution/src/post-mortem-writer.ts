import { pool } from './db.js';
import type { streaming } from '@alpacahq/alpaca-trade-api';
type TradeUpdate = streaming.TradeUpdate;

export async function writePostMortem(
  update: TradeUpdate,
  intentId: string,
  bracketJson: unknown,
  entryPrice: number,
  side: string,
  fillQty: number,
): Promise<void> {
  try {
    const bracket = bracketJson as {
      take_profit_price?: number;
      stop_loss_price?: number;
    } | null;

    const fillPrice = parseFloat(
      update.price ??
        (update.order['filledAvgPrice'] as string | undefined) ??
        (update.order['filled_avg_price'] as string | undefined) ??
        '0',
    );

    const tp = bracket?.take_profit_price ?? Infinity;
    const sl = bracket?.stop_loss_price ?? 0;

    let exitReason: string;
    if (fillPrice >= tp * 0.995) {
      exitReason = 'take_profit';
    } else if (sl > 0 && fillPrice <= sl * 1.005) {
      exitReason = 'stop_loss';
    } else {
      exitReason = 'manual';
    }

    const classification =
      exitReason === 'take_profit' ? 'thesis_right' :
      exitReason === 'stop_loss'   ? 'thesis_wrong' :
                                     'resolution_mismatch';

    const dirMult = side === 'buy' ? 1 : -1;
    const realizedPnl = (fillPrice - entryPrice) * fillQty * dirMult;

    const ticker: string = (update.order['symbol'] as string | undefined) ?? '';

    await pool.query(
      `INSERT INTO post_mortems
         (intent_id, ticker, side, entry_price, exit_price, realized_pnl_usd, classification, exit_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [intentId, ticker, side, entryPrice, fillPrice, realizedPnl.toFixed(2), classification, exitReason],
    );

    console.log(
      `[execution] post-mortem: ${ticker} ${exitReason} pnl=${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)} (${classification})`,
    );
  } catch (err) {
    console.error('[execution] post-mortem-writer: error (non-fatal)', err);
  }
}
