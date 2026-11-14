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

import './preflight.js';
import cron from 'node-cron';
import { pool } from './db.js';
import { initScheduler, runCycle, runCryptoCycle } from './scheduler.js';
import { explainBootError } from './log.js';

process.on('SIGTERM', async () => {
  console.log('[control-plane] SIGTERM received, shutting down');
  await pool.end();
  process.exit(0);
});

async function main(): Promise<void> {
  console.log('[control-plane] boot');
  console.log(
    `[control-plane][boot] ${JSON.stringify({
      run_once: process.env['RUN_ONCE'] === 'true',
      run_mode: process.env['RUN_MODE'] ?? 'all',
      node: process.version,
      utc: new Date().toISOString(),
      env_present: {
        DATABASE_URL: Boolean(process.env['DATABASE_URL']),
        DATABASE_URL_has_password: (() => { try { return new URL(process.env['DATABASE_URL'] ?? '').password !== ''; } catch { return false; } })(),
        PGPASSWORD: Boolean(process.env['PGPASSWORD']),
        ANTHROPIC_API_KEY: Boolean(process.env['ANTHROPIC_API_KEY']),
        WATCH_SYMBOLS: process.env['WATCH_SYMBOLS'] ?? null,
      },
      classifier_backend: process.env['USE_JEV'] === 'true' ? 'jev' : 'llm',
      crypto_exit_dry_run: process.env['CRYPTO_EXIT_DRY_RUN'] !== 'false',
      crypto_averaging_enabled: process.env['CRYPTO_AVERAGING_ENABLED'] !== 'false',
      crypto_averaging_dry_run: process.env['CRYPTO_AVERAGING_DRY_RUN'] !== 'false',
    })}`,
  );

  const who = await pool.query<{ u: string }>('SELECT current_user AS u');
  console.log(`[control-plane][boot] connected to database as ${who.rows[0]?.u}`);

  await initScheduler();

  // Run once immediately for dev/smoke test convenience, then on cron.
  // In production, Render Cron fires once per day at 9:30 AM ET —
  // the window check inside runCycle() guards against out-of-window fires.
  if (process.env['RUN_ONCE'] === 'true') {
    // RUN_MODE: 'stock' | 'crypto' | 'all' (default). Render runs one cron per mode.
    const mode = process.env['RUN_MODE'] ?? 'all';
    // Each cycle handles its own errors, but isolate them anyway: a stock failure must never
    // stop the crypto cycle (RUN_MODE=all) or skip the clean shutdown below.
    if (mode === 'stock' || mode === 'all') {
      await runCycle().catch((err) => console.error('[control-plane][stock] unhandled', err));
    }
    if (mode === 'crypto' || mode === 'all') {
      await runCryptoCycle().catch((err) => console.error('[control-plane][crypto] unhandled', err));
    }
    console.log('[control-plane][boot] run complete, exiting');
    await pool.end();
    return;
  }

  // Minute-level cron: fires every minute 9:25–10:35 ET weekdays.
  // runCycle() enforces the 9:30–10:30 window itself; the cron just wakes it up.
  cron.schedule('* 9,10 * * 1-5', () => {
    runCycle().catch((err) => console.error('[control-plane] runCycle error', err));
  }, { timezone: 'America/New_York' });

  // Crypto cron: every 2 hours, 24/7 (no trading window — crypto never closes)
  cron.schedule('0 */2 * * *', () => {
    runCryptoCycle().catch((err) => console.error('[control-plane] runCryptoCycle error', err));
  });

  console.log('[control-plane] cron scheduled — waiting for trading window');
}

main().catch((err) => {
  console.error('[control-plane] fatal boot error', err);
  console.error(`[control-plane][boot] DIAGNOSIS: ${explainBootError(err)}`);
  process.exit(1);
});
