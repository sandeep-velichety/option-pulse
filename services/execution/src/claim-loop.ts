import { pool } from './db.js';
import { submitOrder } from './order-submitter.js';

export async function claimAndSubmit(): Promise<void> {
  const client = await pool.connect();
  let claimedRows: Array<Record<string, unknown>> = [];

  try {
    await client.query('BEGIN');

    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM trade_intents
       WHERE status = 'pending' AND expires_at > NOW()
       ORDER BY created_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED`,
    );

    if (result.rows.length === 0) {
      await client.query('COMMIT');
      return;
    }

    for (const row of result.rows) {
      await client.query(
        `UPDATE trade_intents SET status = 'claimed' WHERE intent_id = $1`,
        [row['intent_id']],
      );
    }

    await client.query('COMMIT');
    claimedRows = result.rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[execution] claim-loop rollback error', rollbackErr);
    }
    console.error('[execution] claim-loop transaction error', err);
    return;
  } finally {
    client.release();
  }

  for (const row of claimedRows) {
    await submitOrder(row);
  }
}
