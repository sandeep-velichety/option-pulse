import { pool } from './db.js';

export interface PostMortemInput {
  intentId: string;
  ticker: string;
  /** Volume-weighted average entry price of the closed long. */
  entryPrice: number;
  exitPrice: number;
  qty: number;
  exitReason: 'stop_loss' | 'take_profit' | 'time_exit' | 'recovery' | 'loss_reduction';
}

/**
 * Writes one post_mortems row when a crypto long is closed by an exit order.
 * Non-fatal: a failure here must never disturb fill/NAV bookkeeping (and the table may not
 * exist yet if migration 002 has not been applied).
 */
export async function writePostMortem(i: PostMortemInput): Promise<void> {
  try {
    // post_mortems.exit_reason CHECK allows: take_profit | stop_loss | expired | manual
    // post_mortems.classification CHECK allows: thesis_right | thesis_wrong | execution_bug |
    //                                           lucky_win | resolution_mismatch
    const realizedForClass = (i.exitPrice - i.entryPrice) * i.qty;
    let exitReason: 'take_profit' | 'stop_loss' | 'expired' | 'manual';
    let classification: 'thesis_right' | 'thesis_wrong' | 'lucky_win' | 'resolution_mismatch';
    switch (i.exitReason) {
      case 'take_profit':
        exitReason = 'take_profit';
        classification = 'thesis_right';
        break;
      case 'stop_loss':
        exitReason = 'stop_loss';
        classification = 'thesis_wrong';
        break;
      case 'time_exit':
        exitReason = 'expired';
        classification = 'resolution_mismatch'; // closed on the clock, not on the thesis
        break;
      case 'recovery': // closed after cost-averaging pulled break-even down
        exitReason = 'manual';
        classification = realizedForClass >= 0 ? 'lucky_win' : 'resolution_mismatch';
        break;
      case 'loss_reduction': // stalled recovery: closed to cut the loss
        exitReason = 'manual';
        classification = 'resolution_mismatch';
        break;
    }
    const realizedPnl = (i.exitPrice - i.entryPrice) * i.qty; // long-only

    await pool.query(
      `INSERT INTO post_mortems
         (intent_id, ticker, side, entry_price, exit_price, realized_pnl_usd, classification, exit_reason)
       VALUES ($1, $2, 'buy', $3, $4, $5, $6, $7)`,
      [i.intentId, i.ticker, i.entryPrice, i.exitPrice, realizedPnl.toFixed(2), classification, exitReason],
    );
    console.log(
      `[execution] post-mortem: ${i.ticker} ${exitReason} pnl=${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)} (${classification})`,
    );
  } catch (err) {
    console.error('[execution] post-mortem-writer: error (non-fatal)', err);
  }
}
