import crypto from 'node:crypto';
import { pool } from './db.js';
import { STRATEGY_ID, SLEEVE_ID, CRYPTO_STRATEGY_ID, CRYPTO_SLEEVE_ID } from './council.js';
import type { SessionResult } from './types.js';

function etTodayISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function deterministicClientOrderId(
  strategyId: string,
  ticker: string,
  side: string,
  tradeDate: string,
  decisionId: string,
): string {
  const input = `${strategyId}|${ticker}|${side}|${tradeDate}|${decisionId}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

export async function ensureStrategy(): Promise<void> {
  await pool.query(
    `INSERT INTO strategies (strategy_id, sleeve_id, asset_class, version, status)
     VALUES ($1, $2, 'stock', 1, 'active')
     ON CONFLICT (strategy_id) DO NOTHING`,
    [STRATEGY_ID, SLEEVE_ID],
  );
}

export async function ensureCryptoStrategy(): Promise<void> {
  await pool.query(
    `INSERT INTO strategies (strategy_id, sleeve_id, asset_class, version, status)
     VALUES ($1, $2, 'crypto', 1, 'active')
     ON CONFLICT (strategy_id) DO NOTHING`,
    [CRYPTO_STRATEGY_ID, CRYPTO_SLEEVE_ID],
  );
}

export async function writeJournal(
  result: SessionResult,
  snapshotId: string,
): Promise<void> {
  // Pre-transaction: upsert prompt_versions (non-deferred FK from agent_runs)
  for (const run of result.agentRunRecords) {
    const promptVersionRole = run.promptRole === 'allocator'
      ? 'allocator'
      : run.promptRole === 'risk_officer' ? 'risk_officer' : 'adversary';
    await pool.query(
      `INSERT INTO prompt_versions (hash, role, system_prompt)
       VALUES ($1, $2, $3)
       ON CONFLICT (hash) DO NOTHING`,
      [run.promptVersionHash, promptVersionRole, run.systemPrompt],
    );
  }

  const ticker = result.recommendation?.ticker ?? 'NONE';
  const decisionId = result.decisionId;

  // Map internal verdict to DB verdict enum
  const dbVerdict = result.councilVerdictEnum; // values already match DB CHECK constraint

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert all agent_runs (FK to decisions is DEFERRABLE INITIALLY DEFERRED)
    for (const run of result.agentRunRecords) {
      await client.query(
        `INSERT INTO agent_runs (
           run_id, decision_id, role, agent_version, model, input_hash,
           prompt_version_hash, messages, effort, raw_output, parsed_output,
           schema_valid, stop_reason, input_tokens, output_tokens,
           cache_read_input_tokens, cache_creation_input_tokens,
           cost_usd, latency_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          run.runId,
          decisionId,
          run.role,
          run.agentVersion,
          run.model,
          run.inputHash,
          run.promptVersionHash,
          JSON.stringify(run.messages),
          null,
          run.rawOutput,
          JSON.stringify(run.parsedOutput),
          run.schemaValid,
          run.stopReason,
          run.inputTokens,
          run.outputTokens,
          run.cacheReadInputTokens,
          run.cacheCreationInputTokens,
          run.costUsd,
          run.latencyMs,
        ],
      );
    }

    // 2. Insert decisions (creates the row the deferred FK will resolve against)
    // Crypto tickers contain '/'. Previously every intent-less decision (all abstains) was labelled stock.
    const decisionStrategyId =
      result.pendingIntent?.strategy_id ?? (ticker.includes('/') ? CRYPTO_STRATEGY_ID : STRATEGY_ID);
    await client.query(
      `INSERT INTO decisions (
         decision_id, strategy_id, snapshot_id, ticker, verdict, verdict_reason, gate_result
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        decisionId,
        decisionStrategyId,
        snapshotId,
        ticker,
        dbVerdict,
        result.verdictReason,
        result.gateResult ? JSON.stringify(result.gateResult) : null,
      ],
    );

    // 3. Insert trade_intent if approved (regular FK — decisions row now exists)
    if (result.pendingIntent !== null) {
      const intent = result.pendingIntent;
      const tradeDate = etTodayISO();
      const clientOrderId = deterministicClientOrderId(
        intent.strategy_id,
        intent.ticker,
        intent.side,
        tradeDate,
        decisionId,
      );
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

      await client.query(
        `INSERT INTO trade_intents (
           intent_id, run_id, decision_id, client_order_id, ticker, side, qty,
           notional_usd, order_type, limit_price, time_in_force, bracket,
           bet_class, sleeve_id, strategy_id, sizing, expires_at, status, schema_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          crypto.randomUUID(),
          intent.sessionRunId,
          decisionId,
          clientOrderId,
          intent.ticker,
          intent.side,
          intent.qty,
          intent.notional_usd,
          'market',
          null,
          'day',
          JSON.stringify(intent.bracket),
          intent.bet_class,
          intent.sleeve_id,
          intent.strategy_id,
          JSON.stringify(intent.sizing),
          expiresAt,
          'pending',
          1,
        ],
      );
    }

    await client.query('COMMIT');
    console.log(
      `[control-plane] journal written: decision=${decisionId} verdict=${dbVerdict} ticker=${ticker}` +
        (result.pendingIntent ? ` intent=pending notional=${result.pendingIntent.notional_usd.toFixed(2)}` : ''),
    );
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[control-plane] journal write failed, rolled back', err);
    throw err;
  } finally {
    client.release();
  }
}

export interface ManagedIntentParams {
  ticker: string;
  /** Units to trade. For a buy this is notional / last. */
  qty: number;
  lastPrice: number;
  navUsd: number;
  snapshotId: string;
  /** exit: 'stop_loss' | 'take_profit' | 'time_exit' | 'recovery' | 'loss_reduction'; add: 'averaging_add' */
  reason: string;
  detail: string;
}

/**
 * Journal a deterministic position-management action: one decision row (verdict 'approve') plus
 * a trade intent that flows through the normal claim -> submit -> fill pipeline. The control-plane
 * never touches Alpaca; execution places the order.
 *
 *   side 'sell' = exit.  bracket.exit_reason carries why, because exec_role cannot read
 *                 `decisions` but must know it for post-mortems.
 *   side 'buy'  = cost-averaging add. bracket.averaging_add / add_ref_price let the next cycle
 *                 count tranches and space the next add from this price.
 *
 * The TradeIntent zod schema ignores unknown bracket keys; bracket prices are placeholders
 * (crypto orders are plain market orders).
 */
async function writeManagedIntent(side: 'buy' | 'sell', p: ManagedIntentParams): Promise<string> {
  const decisionId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const clientOrderId = deterministicClientOrderId(
    CRYPTO_STRATEGY_ID,
    p.ticker,
    side,
    etTodayISO(),
    decisionId,
  );
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const notional = Math.max(p.qty * p.lastPrice, 0.01);
  const isAdd = side === 'buy';
  const bracket = isAdd
    ? {
        take_profit_price: p.lastPrice * 1.2,
        stop_loss_price: p.lastPrice * 0.9,
        averaging_add: true,
        add_ref_price: p.lastPrice,
      }
    : { take_profit_price: p.lastPrice, stop_loss_price: p.lastPrice, exit_reason: p.reason };
  const kelly = isAdd && p.navUsd > 0 ? Math.min(notional / p.navUsd, 0.05) : 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO decisions (decision_id, strategy_id, snapshot_id, ticker, verdict, verdict_reason, gate_result)
       VALUES ($1, $2, $3, $4, 'approve', $5, NULL)`,
      [
        decisionId,
        CRYPTO_STRATEGY_ID,
        p.snapshotId,
        p.ticker,
        `${isAdd ? 'averaging:add' : `exit:${p.reason}`} — ${p.detail}`,
      ],
    );
    await client.query(
      `INSERT INTO trade_intents (
         intent_id, run_id, decision_id, client_order_id, ticker, side, qty,
         notional_usd, order_type, limit_price, time_in_force, bracket,
         bet_class, sleeve_id, strategy_id, sizing, expires_at, status, schema_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'market',NULL,'day',$9,'core',$10,$11,$12,$13,'pending',1)`,
      [
        intentId,
        crypto.randomUUID(),
        decisionId,
        clientOrderId,
        p.ticker,
        side,
        p.qty.toFixed(8),
        notional.toFixed(2),
        JSON.stringify(bracket),
        CRYPTO_SLEEVE_ID,
        CRYPTO_STRATEGY_ID,
        JSON.stringify({
          nav_at_decision: p.navUsd,
          edge: 0,
          variance: 0,
          kelly_f_raw: null,
          kelly_f_capped: kelly,
          cap_applied: 'none',
        }),
        expiresAt,
      ],
    );
    await client.query('COMMIT');
    console.log(
      `[control-plane] ${isAdd ? 'averaging add' : 'exit'} intent written: ${p.ticker} ${side} qty=${p.qty} reason=${p.reason} decision=${decisionId}`,
    );
    return decisionId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const writeExitIntent = (p: ManagedIntentParams): Promise<string> => writeManagedIntent('sell', p);
export const writeAddIntent = (p: ManagedIntentParams): Promise<string> => writeManagedIntent('buy', p);

/**
 * Persist a cycle that produced no council decision (stale data, or the cycle crashed) as a
 * decisions row, so it is visible on the ops dashboard instead of only in ephemeral logs.
 * Uses the existing verdicts 'stale_snapshot' / 'schema_failure' (ops-web labels the latter
 * "Agent / cycle error"). Deduped: at most one row per (verdict, strategy) per `dedupeMinutes`,
 * so a minute-level cron cannot flood the table. Never throws.
 */
export async function writeCycleNote(p: {
  assetClass: 'stock' | 'crypto';
  verdict: 'stale_snapshot' | 'schema_failure';
  snapshotId: string;
  reason: string;
  dedupeMinutes: number;
}): Promise<void> {
  const strategyId = p.assetClass === 'crypto' ? CRYPTO_STRATEGY_ID : STRATEGY_ID;
  try {
    const dup = await pool.query(
      `SELECT 1 FROM decisions
        WHERE verdict = $1 AND strategy_id = $2 AND ticker = 'NONE'
          AND created_at > now() - ($3 || ' minutes')::interval LIMIT 1`,
      [p.verdict, strategyId, String(p.dedupeMinutes)],
    );
    if (dup.rows.length > 0) return;
    await pool.query(
      `INSERT INTO decisions (decision_id, strategy_id, snapshot_id, ticker, verdict, verdict_reason, gate_result)
       VALUES ($1, $2, $3, 'NONE', $4, $5, NULL)`,
      [crypto.randomUUID(), strategyId, p.snapshotId, p.verdict, p.reason.slice(0, 2000)],
    );
  } catch (err) {
    console.error('[control-plane] writeCycleNote failed (non-fatal)', err);
  }
}
