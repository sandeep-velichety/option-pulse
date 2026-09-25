// execution-service: rate-limited Alpaca client, risk gate, trade_intents
// poller, order submission, reconciliation, NAV tracker, market_snapshots
// writer.
//
// Invariant (Ship Order §2): this process holds ALPACA_KEY/ALPACA_SECRET
// and exec_role DB credentials only. It must have no LLM/Anthropic
// dependency of any kind, and must never accept inbound traffic from the
// public internet. This is enforced here at runtime and should also be
// enforced in CI (Ship Order M1: credential-boundary guard).

if (process.env['ANTHROPIC_API_KEY']) {
  throw new Error(
    'execution-service must never hold an LLM credential — credential isolation violated',
  );
}

// Validate required env vars before importing modules that throw on missing vars
const requiredVars = [
  'EXEC_DATABASE_URL',
  'ALPACA_KEY',
  'ALPACA_SECRET',
  'WATCH_SYMBOLS',
] as const;

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    throw new Error(`[execution] ${varName} is required`);
  }
}

import cron from 'node-cron';
import { pool } from './db.js';
import { claimAndSubmit } from './claim-loop.js';
import { writeSnapshot } from './snapshot-writer.js';
import { startTradeStream, stopStream } from './trade-stream.js';
import { runEodReconciliation } from './reconciliation.js';

// Start trade stream
startTradeStream();

// Claim loop: run every 2 seconds
const claimInterval = setInterval(() => {
  claimAndSubmit().catch((err) => {
    console.error('[execution] claim-loop uncaught error', err);
  });
}, 2_000);

// Snapshot writer: every 5 minutes during market hours (9–16 ET, Mon–Fri)
cron.schedule(
  '*/5 9-16 * * 1-5',
  () => {
    writeSnapshot().catch((err) => {
      console.error('[execution] snapshot-writer cron error', err);
    });
  },
  { timezone: 'America/New_York' },
);

// Run snapshot once on boot
writeSnapshot().catch((err) => {
  console.error('[execution] snapshot-writer boot error', err);
});

// EOD reconciliation: 4:35 PM ET on weekdays
cron.schedule(
  '35 16 * * 1-5',
  () => {
    runEodReconciliation().catch((err) => {
      console.error('[execution] reconciliation cron error', err);
    });
  },
  { timezone: 'America/New_York' },
);

// Graceful shutdown
process.on('SIGTERM', () => {
  void (async () => {
    console.log('[execution] SIGTERM received, shutting down');
    clearInterval(claimInterval);
    stopStream();
    await pool.end();
    process.exit(0);
  })();
});

console.log('[execution] started');
