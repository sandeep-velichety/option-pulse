import { evaluateExit, managePosition } from '@trading-council/sizer';
import type { MarketSnapshot } from '@trading-council/contracts';
import { sendAlert } from '@trading-council/alerts';
import { pool } from './db.js';
import { writeExitIntent, writeAddIntent } from './journal.js';
import { toIntentTicker, isCryptoTicker } from './tickers.js';

/**
 * Crypto position management. Alpaca paper cannot attach stop-loss / take-profit to crypto
 * orders, so without this a crypto position is never closed. Runs at the start of every crypto
 * cycle, before the council, and costs no LLM tokens.
 *
 * Two modes:
 *   CRYPTO_AVERAGING_ENABLED (default true): `managePosition` decides HOLD / ADD / EXIT. It will
 *     cost-average a losing position — but only when it makes sense (see packages/sizer/src/
 *     averaging.ts) — and exits at the LOWERED average cost, i.e. possibly below the original
 *     entry, for a smaller loss or a profit.
 *   CRYPTO_AVERAGING_ENABLED=false: the older fixed stop-loss / take-profit / time exit only.
 *
 * Switches (all default to the SAFE value; flip deliberately):
 *   CRYPTO_EXITS_ENABLED       default true   'false' disables all management
 *   CRYPTO_EXIT_DRY_RUN        default TRUE   exits are only logged, never sold
 *   CRYPTO_AVERAGING_DRY_RUN   default TRUE   adds are only logged, never bought
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

interface Ladder {
  openedAt: Date | null;
  horizonDays: number | null;
  intentTakeProfitPrice: number | null;
  intentStopPrice: number | null;
  adds: number;
  lastAddPrice: number | null;
  lastAddAt: Date | null;
}

/**
 * Reconstruct the averaging ladder from the intents of the CURRENT holding: submitted buy
 * intents since the last submitted sell. The first is the opening buy; later ones tagged
 * bracket.averaging_add are adds. (cp_role cannot read fills/orders, so intents are the record.)
 */
async function loadLadder(ticker: string): Promise<Ladder> {
  const r = await pool.query<{ created_at: Date; bracket: unknown; horizon: string | null }>(
    `SELECT ti.created_at, ti.bracket,
            (SELECT a.parsed_output->>'horizon_days' FROM agent_runs a
              WHERE a.decision_id = ti.decision_id AND a.role = 'allocator' LIMIT 1) AS horizon
       FROM trade_intents ti
      WHERE ti.ticker = $1 AND ti.side = 'buy' AND ti.status = 'submitted'
        AND ti.created_at > COALESCE(
              (SELECT MAX(created_at) FROM trade_intents
                WHERE ticker = $1 AND side = 'sell' AND status = 'submitted'),
              '-infinity'::timestamptz)
      ORDER BY ti.created_at ASC`,
    [ticker],
  );
  const parse = (b: unknown) =>
    (typeof b === 'string' ? JSON.parse(b) : b) as
      | {
          stop_loss_price?: number;
          take_profit_price?: number;
          averaging_add?: boolean;
          add_ref_price?: number;
        }
      | undefined;

  const first = r.rows[0];
  const fb = parse(first?.bracket);
  const horizon = first?.horizon != null ? parseFloat(first.horizon) : NaN;
  const addRows = r.rows.slice(1).filter((row) => parse(row.bracket)?.averaging_add === true);
  const lastAdd = addRows[addRows.length - 1];
  const la = parse(lastAdd?.bracket);
  return {
    openedAt: first?.created_at ?? null,
    horizonDays: Number.isFinite(horizon) ? horizon : null,
    intentTakeProfitPrice: fb?.take_profit_price ?? null,
    intentStopPrice: fb?.stop_loss_price ?? null,
    adds: addRows.length,
    lastAddPrice: typeof la?.add_ref_price === 'number' ? la.add_ref_price : null,
    lastAddAt: lastAdd?.created_at ?? null,
  };
}

export async function runCryptoExits(snapshot: MarketSnapshot, snapshotId: string): Promise<void> {
  if (process.env['CRYPTO_EXITS_ENABLED'] === 'false') return;
  const exitDry = process.env['CRYPTO_EXIT_DRY_RUN'] !== 'false';
  const addDry = process.env['CRYPTO_AVERAGING_DRY_RUN'] !== 'false';
  const averaging = process.env['CRYPTO_AVERAGING_ENABLED'] !== 'false';

  const posRow = await pool.query<{ positions: unknown }>(
    `SELECT positions FROM positions_snapshot ORDER BY as_of DESC LIMIT 1`,
  );
  const held = parseHeldCrypto(posRow.rows[0]?.positions);
  if (held.length === 0) return;

  const navRow = await pool.query<{
    nav_usd: string;
    drawdown_fraction: string;
    daily_pnl_usd: string;
    halt_level: number;
  }>(
    `SELECT nav_usd, drawdown_fraction, daily_pnl_usd, halt_level
       FROM nav_history ORDER BY as_of DESC LIMIT 1`,
  );
  const nav = navRow.rows[0];
  const navUsd = parseFloat(nav?.nav_usd ?? '0');
  const drawdown = parseFloat(nav?.drawdown_fraction ?? '0');
  const dailyPnl = parseFloat(nav?.daily_pnl_usd ?? '0');
  const haltLevel = nav?.halt_level ?? 0;

  for (const pos of held) {
    const sym = snapshot.symbols[pos.ticker];
    const last = sym?.last;
    const tag = (dry: boolean) => (dry ? '[exits][DRY RUN]' : '[exits]');
    if (!(typeof last === 'number' && last > 0)) {
      console.log(`[exits] ${pos.ticker}: no price in crypto snapshot, skipping`);
      continue;
    }

    // Anything already in flight for this ticker (either side)? Let it settle first.
    // 'pending'/'claimed' mean execution has not placed the order yet: block until they expire.
    // 'submitted' is never advanced to a final status and market orders fill in seconds, so it only
    // blocks for a short window — otherwise every add/exit would leave the ticker (and its stops)
    // unmanaged for the full 8h expiry. positions_snapshot is refreshed on the fill itself.
    const live = await pool.query(
      `SELECT side FROM trade_intents
        WHERE ticker = $1 AND expires_at > NOW()
          AND (status IN ('pending', 'claimed')
               OR (status = 'submitted' AND created_at > NOW() - INTERVAL '15 minutes'))
        LIMIT 1`,
      [pos.ticker],
    );
    if (live.rows.length > 0) {
      console.log(`[exits] ${pos.ticker}: a ${live.rows[0].side} intent is still in flight, skipping`);
      continue;
    }

    const ladder = await loadLadder(pos.ticker);

    // ---- legacy mode: fixed stop / take-profit / time exit -------------------------------------
    if (!averaging) {
      const d = evaluateExit({
        entryPrice: pos.avgEntry,
        lastPrice: last,
        intentStopPrice: ladder.intentStopPrice,
        intentTakeProfitPrice: ladder.intentTakeProfitPrice,
        openedAt: ladder.openedAt,
        horizonDays: ladder.horizonDays,
        now: new Date(),
      });
      if (!d.exit || !d.reason) {
        console.log(`${tag(exitDry)} ${pos.ticker}: ${d.detail}`);
        continue;
      }
      await applyExit(pos, last, navUsd, snapshotId, d.reason, d.detail, exitDry);
      continue;
    }

    // ---- averaging mode -------------------------------------------------------------------------
    const closes = (sym?.bars_1d ?? []).map((b) => b.c);
    const m = managePosition({
      entryPrice: pos.avgEntry,
      lastPrice: last,
      qty: pos.qty,
      navUsd,
      haltLevel,
      drawdownFraction: drawdown,
      dailyPnlUsd: dailyPnl,
      adds: ladder.adds,
      lastAddPrice: ladder.lastAddPrice,
      lastAddAt: ladder.lastAddAt,
      openedAt: ladder.openedAt,
      horizonDays: ladder.horizonDays,
      intentTakeProfitPrice: ladder.intentTakeProfitPrice,
      prevClose: sym?.prev_close ?? null,
      volumeZ: sym?.volume_z_20d ?? null,
      recentCloses: closes,
      now: new Date(),
    });

    if (m.action === 'hold') {
      console.log(
        `[exits] ${pos.ticker}: ${m.detail}` +
          (m.blockers.length ? ` | blockers: ${m.blockers.join('; ')}` : ''),
      );
      continue;
    }

    if (m.action === 'exit' && m.reason) {
      await applyExit(pos, last, navUsd, snapshotId, m.reason, m.detail, exitDry);
      continue;
    }

    if (m.action === 'add' && m.notionalUsd) {
      if (addDry) {
        console.log(
          `${tag(true)} would BUY $${m.notionalUsd.toFixed(0)} of ${pos.ticker} — ${m.detail}. ` +
            `Set CRYPTO_AVERAGING_DRY_RUN=false on control-plane-crypto to enable.`,
        );
        continue;
      }
      await writeAddIntent({
        ticker: pos.ticker,
        qty: m.notionalUsd / last,
        lastPrice: last,
        navUsd,
        snapshotId,
        reason: 'averaging_add',
        detail: m.detail,
      });
      await sendAlert(
        `Crypto averaging add: ${pos.ticker}`,
        `Buying $${m.notionalUsd.toFixed(0)} of ${pos.ticker}\n${m.detail}`,
      ).catch(() => {});
    }
  }
}

async function applyExit(
  pos: HeldPosition,
  last: number,
  navUsd: number,
  snapshotId: string,
  reason: string,
  detail: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(
      `[exits][DRY RUN] would SELL ${pos.ticker} qty=${pos.qty} reason=${reason} — ${detail}. ` +
        `Set CRYPTO_EXIT_DRY_RUN=false on control-plane-crypto to enable.`,
    );
    return;
  }
  await writeExitIntent({
    ticker: pos.ticker,
    qty: pos.qty,
    lastPrice: last,
    navUsd,
    snapshotId,
    reason,
    detail,
  });
  await sendAlert(
    `Crypto exit: ${pos.ticker} (${reason})`,
    `Selling ${pos.qty} ${pos.ticker}\n${detail}`,
  ).catch(() => {});
}
