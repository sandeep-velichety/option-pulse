import { pool } from './db.js';
import { anthropic } from './anthropic-client.js';
import { writeCycleNote } from './journal.js';
import { sendAlert } from '@trading-council/alerts';
import { isAuthFailure, authStatus } from './errors.js';

let authFailed = false;
/** True once any Anthropic auth failure was seen in this process; index.ts then exits non-zero. */
export const councilAuthFailed = (): boolean => authFailed;

/**
 * Free key check (models.list consumes no tokens). Called at the start of every run so a revoked
 * or rotated key is reported before any work — not after a whole cycle has failed. Anything other
 * than 401/403 (network blip, 5xx) is "inconclusive" and never reported as a key problem.
 */
export async function probeAnthropic(): Promise<
  { ok: true } | { ok: false; authFailure: boolean; error: unknown }
> {
  try {
    await anthropic.models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, authFailure: isAuthFailure(err), error: err };
  }
}

/**
 * Report that the Anthropic key was rejected: mark this run failed (so Render shows the cron as
 * failed and sends its own notification), record it on the dashboard, and alert immediately.
 * The alert is sent at most once per `dedupeMinutes` across runs; the dashboard row is the memory.
 */
export async function reportAnthropicAuthFailure(
  scope: string,
  err: unknown,
  dedupeMinutes = 360,
): Promise<void> {
  authFailed = true;
  const status = authStatus(err);
  let shouldAlert = true;
  try {
    const snap = await pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM market_snapshots ORDER BY as_of DESC LIMIT 1`,
    );
    if (snap.rows[0]) {
      shouldAlert = await writeCycleNote({
        assetClass: scope === 'crypto' ? 'crypto' : 'stock',
        verdict: 'schema_failure',
        snapshotId: snap.rows[0].snapshot_id,
        reason: `Anthropic API key rejected (HTTP ${status}) — the council is DOWN; no trading decisions until the key is replaced.`,
        dedupeMinutes,
      });
    }
  } catch {
    /* no database? still alert */
  }
  console.error(
    `[control-plane][${scope}] ANTHROPIC KEY REJECTED (HTTP ${status}) — council is down. ` +
      `Set a new ANTHROPIC_API_KEY on control-plane AND control-plane-crypto.`,
  );
  if (shouldAlert) {
    await sendAlert(
      'Council DOWN: Anthropic API key rejected',
      `The ${scope} control-plane could not authenticate with Anthropic (HTTP ${status}). ` +
        `No trading decisions are being made.\n\n` +
        `Fix: create a new key at platform.claude.com -> Settings -> API keys and set ANTHROPIC_API_KEY on ` +
        `BOTH control-plane and control-plane-crypto in Render (services do not share environment variables).\n` +
        `Stops/exits that need no LLM keep running.`,
    ).catch(() => {});
  }
}
