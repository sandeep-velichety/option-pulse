// Decisions page: every council decision (proposed trades AND abstains) with the reason.
// Read-only. Rendering is pure (rows in, HTML out) so it can be tested without a database.

export interface AgentRunRow {
  role: string;
  out: Record<string, unknown> | null;
}

export interface DecisionRow {
  decision_id: string;
  ticker: string;
  verdict: string;
  verdict_reason: string | null;
  gate_result: { allow?: boolean; checks?: Array<{ name: string; pass: boolean; detail?: string }> } | null;
  created_at: string | Date;
  runs: AgentRunRow[] | null;
  intent: { status: string; side: string; notional: string | number } | null;
}

export interface Filters {
  verdict: string; // 'all' or a verdict value
  asset: string; // 'all' | 'stock' | 'crypto'
  limit: number;
}

export const VERDICTS = [
  'approve',
  'abstain',
  'reject',
  'gate_rejected',
  'schema_failure',
  'no_snapshot',
  'stale_snapshot',
] as const;

const VERDICT_LABEL: Record<string, string> = {
  approve: 'Proposed → approved',
  abstain: 'Abstained',
  reject: 'Rejected by council',
  gate_rejected: 'Blocked by risk gate',
  schema_failure: 'Agent / cycle error',
  no_snapshot: 'No market data',
  stale_snapshot: 'Stale market data (cycle skipped)',
};

const VERDICT_COLOR: Record<string, string> = {
  approve: '#22c55e',
  abstain: '#64748b',
  reject: '#f59e0b',
  gate_rejected: '#ef4444',
  schema_failure: '#ef4444',
  no_snapshot: '#6b7280',
  stale_snapshot: '#6b7280',
};

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function run(runs: AgentRunRow[] | null, prefix: string): Record<string, unknown> | null {
  return runs?.find((r) => r.role === prefix || r.role.startsWith(`${prefix}_`))?.out ?? null;
}

function num(v: unknown, digits = 2): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtTime(v: string | Date): string {
  return new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Short, human reason for the row. The allocator's own words beat the generic verdict_reason. */
function headlineReason(d: DecisionRow, alloc: Record<string, unknown> | null): string {
  if (d.verdict === 'abstain' && alloc?.['thesis']) return String(alloc['thesis']);
  if (d.verdict === 'gate_rejected' && d.gate_result?.checks) {
    const failed = d.gate_result.checks.filter((c) => !c.pass).map((c) => c.name);
    if (failed.length) return `Risk gate failed: ${failed.join(', ')}`;
  }
  return d.verdict_reason ?? (alloc?.['thesis'] ? String(alloc['thesis']) : '—');
}

function detail(d: DecisionRow, alloc: Record<string, unknown> | null): string {
  const adv = run(d.runs, 'adversary');
  const risk = run(d.runs, 'risk_officer');
  const rev = run(d.runs, 'allocator_revision');
  const parts: string[] = [];

  if (alloc) {
    parts.push(`<div class="k">Allocator proposal</div>
      <div>${esc(alloc['direction'] ?? '—')} ${esc(alloc['ticker'] ?? '')}
        · conviction ${num(alloc['conviction'])}
        · edge ${num(alloc['est_edge_bps'], 0)} bps
        · horizon ${esc(alloc['horizon_days'] ?? '—')}d
        · ${esc(alloc['bet_class'] ?? '')}</div>
      <p>${esc(alloc['thesis'] ?? '')}</p>
      ${alloc['invalidation_condition'] ? `<p class="m">Invalidated if: ${esc(alloc['invalidation_condition'])}</p>` : ''}`);
  }
  if (adv) {
    parts.push(`<div class="k">Adversary — ${adv['recommend_veto'] ? '<b class="bad">VETO</b>' : 'no veto'}
      (${esc(adv['flaw_category'] ?? 'none')})</div><p>${esc(adv['rationale'] ?? '')}</p>`);
  }
  if (risk) {
    parts.push(`<div class="k">Risk officer — ${risk['recommend_veto'] ? '<b class="bad">VETO</b>' : 'no veto'}
      (${esc(risk['breach_type'] ?? 'none')})</div><p>${esc(risk['rationale'] ?? '')}</p>`);
  }
  if (rev) {
    parts.push(`<div class="k">Allocator revision — ${rev['maintain_recommendation'] === false ? 'withdrew' : 'maintained'}
      (conviction ${num(rev['conviction_adjustment'])})</div><p>${esc(rev['rationale'] ?? '')}</p>`);
  }
  const checks = d.gate_result?.checks;
  if (checks?.length) {
    parts.push(`<div class="k">Risk gate</div><p>${checks
      .map((c) => `<span class="chk ${c.pass ? 'ok' : 'bad'}" title="${esc(c.detail ?? '')}">${c.pass ? '✓' : '✗'} ${esc(c.name)}</span>`)
      .join(' ')}</p>`);
  }
  if (d.intent) {
    parts.push(`<div class="k">Trade intent</div><p>${esc(d.intent.side)} $${num(d.intent.notional, 0)} — ${esc(d.intent.status)}</p>`);
  }
  if (d.verdict_reason) parts.push(`<div class="k">Verdict reason</div><p>${esc(d.verdict_reason)}</p>`);
  if (!parts.length) parts.push('<p class="m">No agent detail recorded.</p>');
  return parts.join('');
}

export function renderDecisionsPage(
  rows: DecisionRow[],
  counts: Array<{ verdict: string; n: number }>,
  f: Filters,
): string {
  const link = (over: Partial<Filters>) => {
    const q = { ...f, ...over };
    return `/decisions?verdict=${encodeURIComponent(q.verdict)}&asset=${encodeURIComponent(q.asset)}&limit=${q.limit}`;
  };

  const chips = (['all', ...VERDICTS] as string[])
    .map((v) => `<a class="chip ${f.verdict === v ? 'on' : ''}" href="${esc(link({ verdict: v }))}">${esc(v === 'all' ? 'All' : (VERDICT_LABEL[v] ?? v))}</a>`)
    .join('');
  const assets = ['all', 'stock', 'crypto']
    .map((a) => `<a class="chip ${f.asset === a ? 'on' : ''}" href="${esc(link({ asset: a }))}">${esc(a === 'all' ? 'All assets' : a)}</a>`)
    .join('');

  const summary = counts
    .map(
      (c) => `<div class="card"><div class="lbl">${esc(VERDICT_LABEL[c.verdict] ?? c.verdict)}</div>
        <div class="val" style="color:${VERDICT_COLOR[c.verdict] ?? '#e2e8f0'}">${c.n}</div></div>`,
    )
    .join('');

  const body = rows
    .map((d) => {
      const alloc = run(d.runs, 'allocator');
      const isCrypto = d.ticker.includes('/');
      const direction = alloc?.['direction'] && alloc['direction'] !== 'flat' ? String(alloc['direction']) : '';
      const reason = headlineReason(d, alloc);
      return `<tr>
        <td class="m">${esc(fmtTime(d.created_at))}</td>
        <td>${isCrypto ? 'crypto' : d.ticker === 'NONE' ? '—' : 'stock'}</td>
        <td><b>${esc(d.ticker === 'NONE' ? '—' : d.ticker)}</b> ${esc(direction)}</td>
        <td><span class="badge" style="background:${VERDICT_COLOR[d.verdict] ?? '#6b7280'}">${esc(VERDICT_LABEL[d.verdict] ?? d.verdict)}</span></td>
        <td class="why"><details><summary>${esc(reason.length > 140 ? reason.slice(0, 140) + '…' : reason)}</summary>
          <div class="detail">${detail(d, alloc)}</div></details></td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Council decisions</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;max-width:1200px;margin:0 auto}
  h1{font-size:22px;margin-bottom:4px} .sub{color:#64748b;font-size:13px;margin-bottom:16px}
  a{color:#93c5fd;text-decoration:none} nav{margin-bottom:16px;font-size:13px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
  .card{background:#1e293b;border-radius:10px;padding:12px}
  .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b}
  .val{font-size:24px;font-weight:700;margin-top:2px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  .chip{padding:4px 10px;border-radius:999px;background:#1e293b;font-size:12px;color:#94a3b8}
  .chip.on{background:#3b82f6;color:#fff}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#1e293b;border-radius:10px;overflow:hidden;margin-top:12px}
  th{text-align:left;padding:10px 12px;background:#0f172a;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  td{padding:9px 12px;border-top:1px solid #334155;vertical-align:top}
  .m{color:#94a3b8;font-size:12px;white-space:nowrap}
  .badge{color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;white-space:nowrap}
  summary{cursor:pointer} .why{width:55%}
  .detail{margin-top:10px;padding:10px;background:#0f172a;border-radius:8px;font-size:12.5px;line-height:1.5}
  .detail p{margin:2px 0 10px} .k{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-top:6px}
  .bad{color:#ef4444} .chk{display:inline-block;margin-right:8px;padding:1px 6px;border-radius:4px;background:#1e293b}
  .chk.ok{color:#22c55e} .chk.bad{color:#ef4444}
  @media(max-width:700px){.why{width:auto}body{padding:12px}}
</style></head><body>
<nav><a href="/">← Dashboard</a></nav>
<h1>Council decisions</h1>
<p class="sub">Every run of the council: trades proposed, trades abstained, and why. Counts are the last 7 days. Click a reason to expand.</p>
<div class="cards">${summary || '<p class="m">No decisions in the last 7 days.</p>'}</div>
<div class="chips">${chips}</div>
<div class="chips">${assets}</div>
<table><thead><tr><th>Time</th><th>Asset</th><th>Ticker</th><th>Outcome</th><th>Reason</th></tr></thead>
<tbody>${body || '<tr><td colspan="5" class="m">No decisions match these filters.</td></tr>'}</tbody></table>
<script>setTimeout(()=>location.reload(),60000)</script>
</body></html>`;
}
