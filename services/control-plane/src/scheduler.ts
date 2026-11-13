import crypto from 'node:crypto';
import { pool } from './db.js';
import { runCouncil } from './council.js';
import { writeJournal, writeCycleNote, ensureStrategy, ensureCryptoStrategy } from './journal.js';
import { clog, cerr, easternNow } from './log.js';
import { parsePositionTickers } from './tickers.js';
import { runCryptoExits } from './exits.js';
import { sendAlert } from '@trading-council/alerts';
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

type StockSnapshotLoad =
  | { kind: 'ok'; snapshotId: string; snapshot: MarketSnapshot; ageMin: number }
  | { kind: 'none' }
  | { kind: 'stale'; snapshotId: string; ageMin: number };

async function loadLatestSnapshot(): Promise<StockSnapshotLoad> {
  const result = await pool.query<{
    snapshot_id: string;
    as_of: Date;
    snapshot: string;
  }>(`SELECT snapshot_id, as_of, snapshot FROM market_snapshots
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_object_keys(snapshot->'symbols') AS k WHERE k LIKE '%/%'
      )
      ORDER BY as_of DESC LIMIT 1`);

  if (result.rows.length === 0) return { kind: 'none' };
  const row = result.rows[0]!;
  const ageMs = Date.now() - row.as_of.getTime();
  const ageMin = Math.round(ageMs / 60000);
  if (ageMs > SNAPSHOT_STALENESS_MS && process.env['FORCE_CYCLE'] !== 'true') {
    return { kind: 'stale', snapshotId: row.snapshot_id, ageMin };
  }
  return {
    kind: 'ok',
    snapshotId: row.snapshot_id,
    snapshot: row.snapshot as unknown as MarketSnapshot,
    ageMin,
  };
}

async function loadLatestCryptoSnapshot(): Promise<{
  snapshotId: string;
  snapshot: MarketSnapshot;
} | null> {
  // Find the most recent snapshot whose symbols are all crypto (contain '/')
  const result = await pool.query<{
    snapshot_id: string;
    as_of: Date;
    snapshot: string;
  }>(`SELECT snapshot_id, as_of, snapshot FROM market_snapshots
      WHERE snapshot->'symbols' ?| (
        SELECT array_agg(key) FROM jsonb_object_keys(snapshot->'symbols') AS key
        WHERE key LIKE '%/%'
      )
      ORDER BY as_of DESC LIMIT 1`);

  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  const ageMs = Date.now() - row.as_of.getTime();
  const CRYPTO_STALENESS_MS = 15 * 60 * 1000; // 15 min — crypto is 24/7, fresher threshold
  if (ageMs > CRYPTO_STALENESS_MS && process.env['FORCE_CYCLE'] !== 'true') {
    console.log(
      `[control-plane] crypto snapshot stale: age=${Math.round(ageMs / 60000)}min, skipping`,
    );
    return null;
  }
  return { snapshotId: row.snapshot_id, snapshot: row.snapshot as unknown as MarketSnapshot };
}

async function loadPortfolioState(): Promise<PortfolioState> {
  const [navResult, asymResult, tickersResult, positionsResult] = await Promise.all([
    pool.query<{
      nav_usd: string;
      peak_nav_usd: string;
      daily_pnl_usd: string;
      halt_level: number;
    }>(`SELECT nav_usd, peak_nav_usd, daily_pnl_usd, halt_level
        FROM nav_history ORDER BY as_of DESC LIMIT 1`),
    // Only LIVE intents count. A 'submitted' intent is never moved to a final status, so
    // without the expiry filter one filled order blocks its ticker (and eats the asymmetric
    // budget) forever — that is what froze all crypto trading after the first fills.
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(notional_usd), 0)::text AS total
       FROM trade_intents
       WHERE status IN ('pending', 'claimed', 'submitted')
         AND expires_at > NOW()
         AND bet_class = 'asymmetric'`,
    ),
    pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM trade_intents
       WHERE status IN ('pending', 'claimed', 'submitted')
         AND expires_at > NOW()`,
    ),
    pool.query<{ positions: unknown }>(
      `SELECT positions FROM positions_snapshot ORDER BY as_of DESC LIMIT 1`,
    ),
  ]);
  const openPositionTickers = parsePositionTickers(positionsResult.rows[0]?.positions);

  if (navResult.rows.length === 0) {
    return {
      haltLevel: 0,
      currentNav: INITIAL_NAV,
      peakNav: INITIAL_NAV,
      dailyPnlUsd: 0,
      asymmetricNotionalOpen: 0,
      openIntentTickers: [],
      openPositionTickers,
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
    openPositionTickers,
  };
}

async function checkDailySpendCap(): Promise<boolean> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
     FROM agent_runs
     WHERE created_at > date_trunc('day', NOW() AT TIME ZONE 'America/New_York')`,
  );
  const spent = parseFloat(result.rows[0]?.total ?? '0');
  console.log(
    `[control-plane] spend_cap ${JSON.stringify({ spent_usd: +spent.toFixed(4), cap_usd: DAILY_SPEND_CAP_USD, ok: spent < DAILY_SPEND_CAP_USD })}`,
  );
  if (spent >= DAILY_SPEND_CAP_USD) {
    console.log(
      `[control-plane] daily spend cap reached: $${spent.toFixed(4)} >= $${DAILY_SPEND_CAP_USD}`,
    );
    await sendAlert(
      'Daily LLM spend cap reached',
      `Spent $${spent.toFixed(4)} — cap is $${DAILY_SPEND_CAP_USD}. No more council cycles today.`,
    ).catch(() => {});
    return false;
  }
  return true;
}

async function loadRecentLessons(assetClass: 'stock' | 'crypto'): Promise<Array<{
  ticker: string;
  classification: string;
  exit_reason: string;
  realized_pnl_usd: string;
  created_at: Date;
}>> {
  try {
    // Filter by asset class: crypto tickers contain '/', stocks do not
    const filter = assetClass === 'crypto' ? "ticker LIKE '%/%'" : "ticker NOT LIKE '%/%'";
    const r = await pool.query(
      `SELECT ticker, classification, exit_reason, realized_pnl_usd, created_at
       FROM post_mortems
       WHERE ${filter}
       ORDER BY created_at DESC LIMIT 5`,
    );
    return r.rows;
  } catch {
    return []; // table may not exist yet before migration runs
  }
}

export async function runCycle(): Promise<void> {
  const cycleId = crypto.randomUUID().slice(0, 8);
  const force = process.env['FORCE_CYCLE'] === 'true';
  const inWindow = isInTradingWindow();
  clog('stock', cycleId, 'start', {
    utc: new Date().toISOString(),
    et: easternNow(),
    window: 'Mon-Fri 09:30-10:30 ET',
    in_window: inWindow,
    force,
    classifier_backend: process.env['USE_JEV'] === 'true' ? 'jev' : 'llm',
  });

  if (!force && !inWindow) {
    clog('stock', cycleId, 'skip', { reason: 'outside_trading_window', et: easternNow() });
    return;
  }

  // `stage` tells the error line exactly where a crash happened.
  let stage = 'spend_cap';
  let snapshotId: string | null = null;
  try {
    const withinCap = await checkDailySpendCap();
    if (!withinCap) {
      clog('stock', cycleId, 'skip', { reason: 'daily_spend_cap_reached' });
      return;
    }

    stage = 'load_snapshot';
    const snap = await loadLatestSnapshot();
    if (snap.kind === 'none') {
      clog('stock', cycleId, 'skip', {
        reason: 'no_stock_snapshot_in_db',
        hint: 'execution has never written a stock snapshot — check execution logs / WATCH_SYMBOLS',
      });
      return;
    }
    snapshotId = snap.snapshotId;
    if (snap.kind === 'stale') {
      clog('stock', cycleId, 'skip', {
        reason: 'stock_snapshot_stale',
        age_min: snap.ageMin,
        max_age_min: SNAPSHOT_STALENESS_MS / 60000,
        snapshot_id: snap.snapshotId,
      });
      await writeCycleNote({
        assetClass: 'stock',
        verdict: 'stale_snapshot',
        snapshotId: snap.snapshotId,
        reason: `stock cycle skipped: latest stock snapshot was ${snap.ageMin} min old (limit ${SNAPSHOT_STALENESS_MS / 60000} min) — is the execution service running?`,
        dedupeMinutes: 360,
      });
      return;
    }
    const priced = Object.entries(snap.snapshot.symbols).filter(([, v]) => v.last > 0).map(([k]) => k);
    if (priced.length === 0) {
      clog('stock', cycleId, 'skip', {
        reason: 'stock_snapshot_has_no_prices',
        snapshot_id: snap.snapshotId,
        hint: 'every symbol has last=0 — execution wrote the snapshot before data was available, or bar fetch is failing (see execution logs)',
      });
      return;
    }
    clog('stock', cycleId, 'snapshot', {
      snapshot_id: snap.snapshotId,
      age_min: snap.ageMin,
      session: snap.snapshot.session,
      symbols: Object.keys(snap.snapshot.symbols),
      priced_symbols: priced.length,
      vix_available: snap.snapshot.regime.vix_stale_days < 999 && snap.snapshot.regime.vix > 0,
    });

    stage = 'load_portfolio';
    const portfolio = await loadPortfolioState();
    stage = 'load_lessons';
    const recentLessons = await loadRecentLessons('stock');
    clog('stock', cycleId, 'portfolio', {
      nav: +portfolio.currentNav.toFixed(2),
      halt_level: portfolio.haltLevel,
      open_intents: portfolio.openIntentTickers,
      held_positions: portfolio.openPositionTickers ?? [],
      lessons: recentLessons.length,
    });

    const sessionRunId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();

    stage = 'council';
    const result = await runCouncil(
      snap.snapshot,
      portfolio,
      sessionRunId,
      decisionId,
      'stock',
      recentLessons,
    );

    stage = 'journal';
    await writeJournal(result, snap.snapshotId);
    clog('stock', cycleId, 'done', {
      verdict: result.councilVerdictEnum,
      reason: result.verdictReason,
      ticker: result.recommendation?.ticker ?? null,
      intent_written: result.pendingIntent !== null,
      decision_id: decisionId,
      cost_usd: +result.agentRunRecords.reduce((s2, r) => s2 + r.costUsd, 0).toFixed(5),
    });
  } catch (err) {
    cerr('stock', cycleId, stage, err);
    if (snapshotId) {
      await writeCycleNote({
        assetClass: 'stock',
        verdict: 'schema_failure',
        snapshotId,
        reason: `stock cycle failed at stage "${stage}": ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        dedupeMinutes: 30,
      });
    }
  }
}

export async function runCryptoCycle(): Promise<void> {
  const cycleId = crypto.randomUUID().slice(0, 8);
  clog('crypto', cycleId, 'start', { utc: new Date().toISOString(), et: easternNow() });

  let stage = 'load_snapshot';
  let snapshotId: string | null = null;
  try {
    const snapshotData = await loadLatestCryptoSnapshot();
    if (!snapshotData) {
      clog('crypto', cycleId, 'skip', { reason: 'no_fresh_crypto_snapshot', max_age_min: 15 });
      return;
    }
    snapshotId = snapshotData.snapshotId;
    clog('crypto', cycleId, 'snapshot', {
      snapshot_id: snapshotData.snapshotId,
      symbols: Object.keys(snapshotData.snapshot.symbols),
      vix_available:
        snapshotData.snapshot.regime.vix_stale_days < 999 && snapshotData.snapshot.regime.vix > 0,
    });

    // Exits first: deterministic, no LLM cost, so they run even when the spend cap is hit.
    stage = 'exits';
    try {
      await runCryptoExits(snapshotData.snapshot, snapshotData.snapshotId);
    } catch (err) {
      cerr('crypto', cycleId, 'exits', err); // non-fatal: the council cycle still runs
    }

    stage = 'spend_cap';
    const withinCap = await checkDailySpendCap();
    if (!withinCap) {
      clog('crypto', cycleId, 'skip', { reason: 'daily_spend_cap_reached' });
      return;
    }

    stage = 'load_portfolio';
    const portfolio = await loadPortfolioState();
    const recentLessons = await loadRecentLessons('crypto');
    clog('crypto', cycleId, 'portfolio', {
      nav: +portfolio.currentNav.toFixed(2),
      halt_level: portfolio.haltLevel,
      open_intents: portfolio.openIntentTickers,
      held_positions: portfolio.openPositionTickers ?? [],
      lessons: recentLessons.length,
    });

    const sessionRunId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();

    stage = 'council';
    const result = await runCouncil(
      snapshotData.snapshot,
      portfolio,
      sessionRunId,
      decisionId,
      'crypto',
      recentLessons,
    );

    stage = 'journal';
    await writeJournal(result, snapshotData.snapshotId);
    clog('crypto', cycleId, 'done', {
      verdict: result.councilVerdictEnum,
      reason: result.verdictReason,
      ticker: result.recommendation?.ticker ?? null,
      intent_written: result.pendingIntent !== null,
      decision_id: decisionId,
      cost_usd: +result.agentRunRecords.reduce((s2, r) => s2 + r.costUsd, 0).toFixed(5),
    });
  } catch (err) {
    cerr('crypto', cycleId, stage, err);
    if (snapshotId) {
      await writeCycleNote({
        assetClass: 'crypto',
        verdict: 'schema_failure',
        snapshotId,
        reason: `crypto cycle failed at stage "${stage}": ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        dedupeMinutes: 30,
      });
    }
  }
}

export async function initScheduler(): Promise<void> {
  await ensureStrategy();
  await ensureCryptoStrategy();
  console.log('[control-plane] scheduler initialised, strategy ensured');
}
