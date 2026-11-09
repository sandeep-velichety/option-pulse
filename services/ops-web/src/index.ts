// ops-web: read-only visibility layer.
// Invariant: ops_role credentials only — SELECT on all tables, no writes.
if (process.env['ANTHROPIC_API_KEY'] || process.env['ALPACA_KEY'] || process.env['ALPACA_SECRET']) {
  throw new Error('ops-web must hold no Alpaca or Anthropic credentials — credential isolation violated');
}

import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { renderDecisionsPage, VERDICTS } from './decisions-page.js';
import type { DecisionRow } from './decisions-page.js';

const { Pool } = pg;

const url = process.env['OPS_DATABASE_URL'];
if (!url) throw new Error('[ops-web] OPS_DATABASE_URL is required');

// Password can come from the URL, OPS_DB_PASSWORD, or PGPASSWORD (first non-empty wins).
// Logged as present/absent only — the value is never printed.
const dbPassword = (process.env['OPS_DB_PASSWORD'] ?? process.env['PGPASSWORD'] ?? '').trim();
let urlHasPassword = false;
try { urlHasPassword = new URL(url).password !== ''; } catch { /* malformed URL handled by pg */ }
console.log(
  `[ops-web] db credentials: url_password=${urlHasPassword} OPS_DB_PASSWORD=${Boolean(process.env['OPS_DB_PASSWORD']?.trim())} PGPASSWORD=${Boolean(process.env['PGPASSWORD']?.trim())}`,
);
if (!urlHasPassword && !dbPassword) {
  console.error('[ops-web] no DB password found: set OPS_DB_PASSWORD (or PGPASSWORD) on this service');
}
const pool = new Pool({
  connectionString: url,
  max: 3,
  ...(dbPassword && !urlHasPassword ? { password: dbPassword } : {}),
});

// Diagnostics: which DB user are we, and what can it read? (username only, never the password)
async function whoAmI(): Promise<string> {
  try {
    const r = await pool.query<{ u: string; dec: boolean; runs: boolean }>(
      `SELECT current_user AS u,
              has_table_privilege(current_user, 'public.decisions', 'SELECT') AS dec,
              has_table_privilege(current_user, 'public.agent_runs', 'SELECT') AS runs`,
    );
    const x = r.rows[0]!;
    return `db user=${x.u} can_select(decisions=${x.dec}, agent_runs=${x.runs})`;
  } catch (e) {
    return `db user unknown (${String(e)})`;
  }
}
whoAmI().then((m) => console.log('[ops-web]', m));

const app = express();
const PORT = process.env['PORT'] ?? '3000';

// This dashboard exposes trading activity, so it must not be open to the internet.
// HTTP Basic auth (constant-time compare). Required in production; /health stays open for probes.
const OPS_USER = process.env['OPS_USER'] ?? 'ops';
const OPS_PASSWORD = process.env['OPS_PASSWORD'];
if (!OPS_PASSWORD && process.env['NODE_ENV'] === 'production') {
  throw new Error('[ops-web] OPS_PASSWORD is required in production');
}
function safeEq(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  if (req.path === '/health' || !OPS_PASSWORD) return next();
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  const [u = '', ...rest] = m ? Buffer.from(m[1]!, 'base64').toString().split(':') : [];
  if (m && safeEq(u, OPS_USER) && safeEq(rest.join(':'), OPS_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="ops"').status(401).send('Authentication required');
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/ops/nav', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT nav_usd, peak_nav_usd, drawdown_fraction, daily_pnl_usd, halt_level, as_of FROM nav_history ORDER BY as_of DESC LIMIT 1'
    );
    res.json(r.rows[0] ?? null);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/decisions', async (req, res) => {
  try {
    const verdictQ = String(req.query['verdict'] ?? 'all');
    const assetQ = String(req.query['asset'] ?? 'all');
    const limitQ = parseInt(String(req.query['limit'] ?? '100'), 10);
    const verdict = (VERDICTS as readonly string[]).includes(verdictQ) ? verdictQ : 'all';
    const asset = ['stock', 'crypto'].includes(assetQ) ? assetQ : 'all';
    const limit = Number.isFinite(limitQ) ? Math.min(Math.max(limitQ, 1), 500) : 100;

    const params: unknown[] = [];
    const where: string[] = [];
    if (verdict !== 'all') { params.push(verdict); where.push(`d.verdict = $${params.length}`); }
    if (asset === 'crypto') where.push(`d.ticker LIKE '%/%'`);
    if (asset === 'stock') where.push(`d.ticker NOT LIKE '%/%'`);
    params.push(limit);

    const [rows, counts] = await Promise.all([
      pool.query<DecisionRow>(
        `SELECT d.decision_id, d.ticker, d.verdict, d.verdict_reason, d.gate_result, d.created_at,
                (SELECT json_agg(json_build_object('role', a.role, 'out', a.parsed_output) ORDER BY a.created_at)
                   FROM agent_runs a WHERE a.decision_id = d.decision_id) AS runs,
                (SELECT json_build_object('status', ti.status, 'side', ti.side, 'notional', ti.notional_usd)
                   FROM trade_intents ti WHERE ti.decision_id = d.decision_id LIMIT 1) AS intent
           FROM decisions d
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY d.created_at DESC
          LIMIT $${params.length}`,
        params,
      ),
      pool.query<{ verdict: string; n: number }>(
        `SELECT verdict, COUNT(*)::int AS n FROM decisions
          WHERE created_at > now() - interval '7 days' GROUP BY verdict ORDER BY n DESC`,
      ),
    ]);
    res.send(renderDecisionsPage(rows.rows, counts.rows, { verdict, asset, limit }));
  } catch (err) {
    console.error('[ops-web] /decisions error', err);
    res.status(500).send('Decisions error: ' + String(err) + '\n\n' + (await whoAmI()));
  }
});

app.get('/api/ops/intents', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ti.ticker, ti.side, ti.notional_usd, ti.status, ti.bet_class, ti.created_at, ti.expires_at,
              d.verdict AS verdict_enum, d.verdict_reason
       FROM trade_intents ti
       LEFT JOIN decisions d ON d.decision_id = ti.decision_id
       ORDER BY ti.created_at DESC LIMIT 10`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/ops/orders', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT ticker, side, qty, order_type, alpaca_status, alpaca_order_id, submitted_at FROM orders ORDER BY created_at DESC LIMIT 10'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/ops/runs', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT role, model, cost_usd, input_tokens, output_tokens, latency_ms, created_at FROM agent_runs ORDER BY created_at DESC LIMIT 20'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/ops/positions', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT positions, total_market_value_usd, asymmetric_notional_usd, source, as_of FROM positions_snapshot ORDER BY as_of DESC LIMIT 1'
    );
    res.json(r.rows[0] ?? null);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/', async (_req, res) => {
  try {
    const [navR, intentsR, ordersR, posR] = await Promise.all([
      pool.query('SELECT nav_usd, peak_nav_usd, drawdown_fraction, daily_pnl_usd, halt_level, as_of FROM nav_history ORDER BY as_of DESC LIMIT 1'),
      pool.query(`SELECT ti.ticker, ti.side, ti.notional_usd, ti.status, ti.bet_class, ti.created_at,
                         d.verdict AS verdict_enum, d.verdict_reason
                  FROM trade_intents ti LEFT JOIN decisions d ON d.decision_id = ti.decision_id
                  ORDER BY ti.created_at DESC LIMIT 10`),
      pool.query('SELECT ticker, side, qty, alpaca_status, alpaca_order_id, submitted_at FROM orders ORDER BY created_at DESC LIMIT 10'),
      pool.query('SELECT positions, total_market_value_usd, as_of FROM positions_snapshot ORDER BY as_of DESC LIMIT 1'),
    ]);

    const nav = navR.rows[0];
    const pos = posR.rows[0];
    const navUsd = nav ? parseFloat(nav.nav_usd) : null;
    const peakUsd = nav ? parseFloat(nav.peak_nav_usd) : null;
    const ddPct = nav ? (parseFloat(nav.drawdown_fraction) * 100).toFixed(2) : '—';
    const pnl = nav ? parseFloat(nav.daily_pnl_usd) : 0;
    const pnlColor = pnl >= 0 ? '#22c55e' : '#ef4444';
    const positions = pos ? (typeof pos.positions === 'string' ? JSON.parse(pos.positions) : (pos.positions ?? [])) : [];

    const statusBadge = (s: string) => {
      const colors: Record<string, string> = { submitted: '#3b82f6', filled: '#22c55e', failed: '#ef4444', rejected: '#6b7280', pending: '#f59e0b', claimed: '#a78bfa' };
      return `<span style="background:${colors[s] ?? '#6b7280'};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${s}</span>`;
    };

    const intentRows = intentsR.rows.map((r: Record<string, unknown>) => `
      <tr>
        <td>${r['ticker']}</td>
        <td>${r['side']}</td>
        <td>$${parseFloat(r['notional_usd'] as string).toFixed(0)}</td>
        <td>${statusBadge(r['status'] as string)}</td>
        <td>${r['bet_class']}</td>
        <td>${r['verdict_enum'] ?? '—'}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r['verdict_reason'] as string ?? '').replace(/"/g,'&quot;')}">${(r['verdict_reason'] as string ?? '').slice(0, 80)}</td>
        <td style="font-size:11px;color:#9ca3af">${new Date(r['created_at'] as string).toLocaleString()}</td>
      </tr>`).join('');

    const orderRows = ordersR.rows.map((r: Record<string, unknown>) => `
      <tr>
        <td>${r['ticker']}</td>
        <td>${r['side']}</td>
        <td>${r['qty']}</td>
        <td>${statusBadge(r['alpaca_status'] as string ?? 'unknown')}</td>
        <td style="font-size:11px">${r['alpaca_order_id']}</td>
        <td style="font-size:11px;color:#9ca3af">${r['submitted_at'] ? new Date(r['submitted_at'] as string).toLocaleString() : '—'}</td>
      </tr>`).join('');

    const positionRows = positions.map((p: Record<string, unknown>) => `
      <tr>
        <td>${p['ticker']}</td>
        <td>${p['qty']}</td>
        <td>$${parseFloat(p['avg_entry_price'] as string).toFixed(2)}</td>
        <td>$${parseFloat(p['market_value'] as string).toFixed(2)}</td>
        <td style="color:${parseFloat(p['unrealized_pnl'] as string) >= 0 ? '#22c55e' : '#ef4444'}">${parseFloat(p['unrealized_pnl'] as string) >= 0 ? '+' : ''}${parseFloat(p['unrealized_pnl'] as string).toFixed(2)}</td>
      </tr>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading Council — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #1e293b; border-radius: 10px; padding: 16px; }
  .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin-bottom: 6px; }
  .card-value { font-size: 26px; font-weight: 700; }
  .card-sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  section { margin-bottom: 32px; }
  h2 { font-size: 15px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #1e293b; border-radius: 10px; overflow: hidden; }
  th { text-align: left; padding: 10px 14px; background: #0f172a; color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  td { padding: 9px 14px; border-top: 1px solid #334155; }
  tr:hover td { background: #263147; }
  .halt-0 { color: #22c55e; } .halt-1 { color: #f59e0b; } .halt-2, .halt-3, .halt-4 { color: #ef4444; }
  .refresh { float: right; font-size: 12px; color: #475569; }
</style>
</head>
<body>
<h1>Trading Council</h1>
<p style="margin-bottom:12px"><a href="/decisions" style="color:#93c5fd">→ Proposed &amp; abstained decisions, with reasons</a></p>
<p class="subtitle">Paper trading dashboard — auto-refreshes every 60s <span class="refresh">Last loaded: ${new Date().toLocaleString()}</span></p>

<div class="cards">
  <div class="card">
    <div class="card-label">NAV</div>
    <div class="card-value">${navUsd != null ? '$' + navUsd.toFixed(2) : '—'}</div>
    <div class="card-sub">Peak: ${peakUsd != null ? '$' + peakUsd.toFixed(2) : '—'}</div>
  </div>
  <div class="card">
    <div class="card-label">Daily P&L</div>
    <div class="card-value" style="color:${pnlColor}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</div>
    <div class="card-sub">Drawdown: ${ddPct}%</div>
  </div>
  <div class="card">
    <div class="card-label">Halt Level</div>
    <div class="card-value class="halt-${nav?.halt_level ?? 0}"">${nav?.halt_level ?? 0} / 4</div>
    <div class="card-sub">${nav?.halt_level === 0 ? 'All clear' : 'HALTED'}</div>
  </div>
  <div class="card">
    <div class="card-label">Open Positions</div>
    <div class="card-value">${positions.length}</div>
    <div class="card-sub">Mkt value: $${pos ? parseFloat(pos.total_market_value_usd).toFixed(2) : '0.00'}</div>
  </div>
</div>

<section>
  <h2>Open Positions</h2>
  ${positions.length === 0 ? '<p style="color:#475569;padding:12px">No open positions</p>' : `
  <table><thead><tr><th>Ticker</th><th>Qty</th><th>Avg Entry</th><th>Market Value</th><th>Unrealized P&L</th></tr></thead>
  <tbody>${positionRows}</tbody></table>`}
</section>

<section>
  <h2>Recent Council Decisions</h2>
  <table><thead><tr><th>Ticker</th><th>Side</th><th>Notional</th><th>Status</th><th>Class</th><th>Verdict</th><th>Reasoning</th><th>Time</th></tr></thead>
  <tbody>${intentRows || '<tr><td colspan="8" style="color:#475569">No decisions yet</td></tr>'}</tbody></table>
</section>

<section>
  <h2>Orders</h2>
  <table><thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th>Status</th><th>Alpaca ID</th><th>Submitted</th></tr></thead>
  <tbody>${orderRows || '<tr><td colspan="6" style="color:#475569">No orders yet</td></tr>'}</tbody></table>
</section>

<script>setTimeout(() => location.reload(), 60000);</script>
</body></html>`);
  } catch (err) {
    res.status(500).send('Dashboard error: ' + String(err) + '\n\n' + (await whoAmI()));
  }
});

app.listen(PORT, () => {
  console.log(`[ops-web] listening on port ${PORT}`);
});
