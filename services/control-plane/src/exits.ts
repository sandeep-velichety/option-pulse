import { evaluateExit } from '@trading-council/sizer';
import type { MarketSnapshot } from '@trading-council/contracts';
import { sendAlert } from '@trading-council/alerts';
import { pool } from './db.js';
import { writeExitIntent } from './journal.js';
import { toIntentTicker, isCryptoTicker } from './tickers.js';

/**
 * Crypto exits. Alpaca paper cannot attach stop-loss / take-profit to crypto orders, so
 * without this a crypto position is never closed. Runs at the start of every crypto cycle.
 *
 * Switches (env):
 *   CRYPTO_EXITS_ENABLED  default true   — 'false' disables exits entirely
 *   CRYPTO_EXIT_DRY_RUN   default TRUE   — only logs what it would do; set to 'false' to
 *                                          actually write sell intents. Defaults to dry-run
 *                                          so deploying this never liquidates a position by
 *                                          surprise; flip it deliberately.
 */
interface HeldPosition {
  ticker: string;
  qty: number;
  avgEntry: number;
}

function parseHeldCrypto(raw: unknown): HeldPosition[] {
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(arr)) return [];
  const out: HeldPosition[] = [];
  for (const p of arr as Array<Record<string, unknown>>) {
    const qty = parseFloat(String(p['qty'] ?? '0'));
    const avgEntry = parseFloat(String(p['avg_entry_price'] ?? '0'));
    const ticker = toIntentTicker(String(p['ticker']));
    if (qty > 0 && avgEntry > 0 && isCryptoTicker(ticker)) out.push({ ticker, qty, avgEntry });
  }
  return out;
}

export async function runCryptoExits(snapshot: MarketSnapshot, snapshotId: string): Promise<void> {
  if (process.env['CRYPTO_EXITS_ENABLED'] === 'false') return;
  const dryRun = process.env['CRYPTO_EXIT_DRY_RUN'] !== 'false';

  const posRow = await pool.query<{ positions: unknown }>(
    `SELECT positions FROM positions_snapshot ORDER BY as_of DESC LIMIT 1`,
  );
  const held = parseHeldCrypto(posRow.rows[0]?.positions);
  if (held.length === 0) return;

  const navRow = await pool.query<{ nav_usd: string }>(
    `SELECT nav_usd FROM nav_history ORDER BY as_of DESC LIMIT 1`,
  );
  const navUsd = parseFloat(navRow.rows[0]?.nav_usd ?? '0');
  const tag = dryRun ? '[exits][DRY RUN]' : '[exits]';

  for (const pos of held) {
    const last = snapshot.symbols[pos.ticker]?.last;
    if (!(typeof last === 'number' && last > 0)) {
      console.log(`${tag} ${pos.ticker}: no price in crypto snapshot, skipping`);
      continue;
    }

    // Already exiting? A live (unexpired) sell intent means the order is in flight.
    const live = await pool.query(
      `SELECT 1 FROM trade_intents
        WHERE ticker = $1 AND side = 'sell'
          AND status IN ('pending', 'claimed', 'submitted') AND expires_at > NOW() LIMIT 1`,
      [pos.ticker],
    );
    if (live.rows.length > 0) {
      console.log(`${tag} ${pos.ticker}: sell intent already live, skipping`);
      continue;
    }

    // Entry context: the latest submitted buy intent (bracket prices, open time, thesis horizon).
    const entry = await pool.query<{ created_at: Date; bracket: unknown; horizon: string | null }>(
      `SELECT ti.created_at, ti.bracket,
              (SELECT a.parsed_output->>'horizon_days' FROM agent_runs a
                WHERE a.decision_id = ti.decision_id AND a.role = 'allocator' LIMIT 1) AS horizon
         FROM trade_intents ti
        WHERE ti.ticker = $1 AND ti.side = 'buy' AND ti.status = 'submitted'
        ORDER BY ti.created_at DESC LIMIT 1`,
      [pos.ticker],
    );
    const e = entry.rows[0];
    const bracket = (typeof e?.bracket === 'string' ? JSON.parse(e.bracket) : e?.bracket) as
      | { stop_loss_price?: number; take_profit_price?: number }
      | undefined;
    const horizon = e?.horizon != null ? parseFloat(e.horizon) : null;

    const decision = evaluateExit({
      entryPrice: pos.avgEntry,
      lastPrice: last,
      intentStopPrice: bracket?.stop_loss_price ?? null,
      intentTakeProfitPrice: bracket?.take_profit_price ?? null,
      openedAt: e?.created_at ?? null,
      horizonDays: Number.isFinite(horizon as number) ? horizon : null,
      now: new Date(),
    });

    if (!decision.exit || !decision.reason) {
      console.log(`${tag} ${pos.ticker}: ${decision.detail}`);
      continue;
    }

    if (dryRun) {
      console.log(
        `${tag} would SELL ${pos.ticker} qty=${pos.qty} reason=${decision.reason} — ${decision.detail}. ` +
          `Set CRYPTO_EXIT_DRY_RUN=false on control-plane-crypto to enable.`,
      );
      continue;
    }

    await writeExitIntent({
      ticker: pos.ticker,
      qty: pos.qty,
      lastPrice: last,
      navUsd,
      snapshotId,
      reason: decision.reason,
      detail: decision.detail,
    });
    await sendAlert(
      `Crypto exit: ${pos.ticker} (${decision.reason})`,
      `Selling ${pos.qty} ${pos.ticker}\n${decision.detail}`,
    ).catch(() => {});
  }
}
