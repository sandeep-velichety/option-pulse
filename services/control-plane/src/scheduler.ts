import crypto from 'node:crypto';
import { pool } from './db.js';
import { runCouncil } from './council.js';
import { writeJournal, ensureStrategy } from './journal.js';
import type { PortfolioState } from '@trading-council/sizer';
import type { MarketSnapshot } from '@trading-council/contracts';

const SNAPSHOT_STALENESS_MS = 30 * 60 * 1000; // 30 minutes
const DAILY_SPEND_CAP_USD = parseFloat(process.env['DAILY_SPEND_CAP_USD'] ?? '2.00');
const INITIAL_NAV = parseFloat(process.env['INITIAL_NAV'] ?? '100000');

function isInTradingWindow(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);

  const isWeekday = !['Saturday', 'Sunday'].includes(weekday);
  const totalMinutes = hour * 60 + minute;
  return isWeekday && totalMinutes >= 9 * 60 + 30 && totalMinutes <= 10 * 60 + 30;
}

async function loadLatestSnapshot(): Promise<{
  snapshotId: string;
  snapshot: MarketSnapshot;
} | null> {
  const result = await pool.query<{
    snapshot_id: string;
    as_of: Date;
    snapshot: string;
  }>(`SELECT snapshot_id, as_of, snapshot FROM market_snapshots ORDER BY as_of DESC LIMIT 1`);

  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  const ageMs = Date.now() - row.as_of.getTime();
  if (ageMs > SNAPSHOT_STALENESS_MS) {
    console.log(
      `[control-plane] snapshot stale: age=${Math.round(ageMs / 60000)}min, skipping`,
    );
    return null;
  }
  return { snapshotId: row.snapshot_id, snapshot: row.snapshot as unknown as MarketSnapshot };
}

async function loadPortfolioState(): Promise<PortfolioState> {
  const [navResult, asymResult, tickersResult] = await Promise.all([
    pool.query<{
      nav_usd: string;
      peak_nav_usd: string;
      daily_pnl_usd: string;
      halt_level: number;
    }>(`SELECT nav_usd, peak_nav_usd, daily_pnl_usd, halt_level
        FROM nav_history ORDER BY as_of DESC LIMIT 1`),
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(notional_usd), 0)::text AS total
       FROM trade_intents
       WHERE status IN ('pending', 'claimed', 'submitted')
         AND bet_class = 'asymmetric'`,
    ),
    pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM trade_intents
       WHERE status IN ('pending', 'claimed', 'submitted')`,
    ),
  ]);

  if (navResult.rows.length === 0) {
    return {
      haltLevel: 0,
      currentNav: INITIAL_NAV,
      peakNav: INITIAL_NAV,
      dailyPnlUsd: 0,
      asymmetricNotionalOpen: 0,
      openIntentTickers: [],
    };
  }

  const nav = navResult.rows[0]!;
  return {
    haltLevel: (nav.halt_level as 0 | 1 | 2 | 3 | 4) ?? 0,
    currentNav: parseFloat(nav.nav_usd),
    peakNav: parseFloat(nav.peak_nav_usd),
    dailyPnlUsd: parseFloat(nav.daily_pnl_usd),
    asymmetricNotionalOpen: parseFloat(asymResult.rows[0]?.total ?? '0'),
    openIntentTickers: tickersResult.rows.map((r) => r.ticker),
  };
}

async function checkDailySpendCap(): Promise<boolean> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
     FROM agent_runs
     WHERE created_at > date_trunc('day', NOW() AT TIME ZONE 'America/New_York')`,
  );
  const spent = parseFloat(result.rows[0]?.total ?? '0');
  if (spent >= DAILY_SPEND_CAP_USD) {
    console.log(
      `[control-plane] daily spend cap reached: $${spent.toFixed(4)} >= $${DAILY_SPEND_CAP_USD}`,
    );
    return false;
  }
  return true;
}

export async function runCycle(): Promise<void> {
  if (!isInTradingWindow()) {
    console.log('[control-plane] outside trading window, skipping cycle');
    return;
  }

  const withinCap = await checkDailySpendCap();
  if (!withinCap) return;

  const snapshotData = await loadLatestSnapshot();
  if (!snapshotData) {
    console.log('[control-plane] no fresh snapshot, skipping cycle');
    return;
  }

  const portfolio = await loadPortfolioState();
  const sessionRunId = crypto.randomUUID();
  const decisionId = crypto.randomUUID();

  console.log(
    `[control-plane] cycle start: session=${sessionRunId} nav=${portfolio.currentNav.toFixed(2)}`,
  );

  try {
    const result = await runCouncil(
      snapshotData.snapshot,
      portfolio,
      sessionRunId,
      decisionId,
    );
    await writeJournal(result, snapshotData.snapshotId);
    console.log(
      `[control-plane] cycle done: verdict=${result.councilVerdictEnum} cost=$${result.agentRunRecords.reduce((s, r) => s + r.costUsd, 0).toFixed(5)}`,
    );
  } catch (err) {
    console.error('[control-plane] cycle error', err);
  }
}

export async function initScheduler(): Promise<void> {
  await ensureStrategy();
  console.log('[control-plane] scheduler initialised, strategy ensured');
}
