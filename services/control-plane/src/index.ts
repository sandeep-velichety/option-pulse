// control-plane: scheduler, market-snapshot reader, specialist agent,
// council (Anthropic Allocator + Jev Risk Officer/Adversary), sizer, journal writer.
//
// Invariant (Ship Order §2): this process holds ANTHROPIC_API_KEY and cp_role DB
// credentials only. It must never read ALPACA_KEY/ALPACA_SECRET and must never
// accept inbound traffic from the public internet. Communication with execution
// is through the database only (market_snapshots read, trade_intents write).

if (process.env['ALPACA_KEY'] || process.env['ALPACA_SECRET']) {
  throw new Error(
    '[control-plane] credential isolation violated — Alpaca keys must never be present here',
  );
}

import cron from 'node-cron';
import { pool } from './db.js';
import { initScheduler, runCycle } from './scheduler.js';

process.on('SIGTERM', async () => {
  console.log('[control-plane] SIGTERM received, shutting down');
  await pool.end();
  process.exit(0);
});

async function main(): Promise<void> {
  console.log('[control-plane] boot');

  await initScheduler();

  // Run once immediately for dev/smoke test convenience, then on cron.
  // In production, Railway Cron fires once per day at 9:30 AM ET —
  // the window check inside runCycle() guards against out-of-window fires.
  if (process.env['RUN_ONCE'] === 'true') {
    await runCycle();
    await pool.end();
    return;
  }

  // Minute-level cron: fires every minute 9:25–10:35 ET weekdays.
  // runCycle() enforces the 9:30–10:30 window itself; the cron just wakes it up.
  cron.schedule('* 9,10 * * 1-5', () => {
    runCycle().catch((err) => console.error('[control-plane] runCycle error', err));
  }, { timezone: 'America/New_York' });

  console.log('[control-plane] cron scheduled — waiting for trading window');
}

main().catch((err) => {
  console.error('[control-plane] fatal boot error', err);
  process.exit(1);
});
