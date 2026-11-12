# Deployment Guide — 30-day paper trading run (Render)

Two services deploy to Render from [`render.yaml`](../render.yaml): **execution** (background
worker, always on) and **control-plane** (cron job, 14:30 UTC Mon–Fri). Both use a shared
**Supabase** Postgres through separate DB roles.

> Hosting moved from Railway to Render after Railway's October 2026 breach exposed customer
> environment variables. See DECISION_LOG.md (2026-11-08). Never reuse any secret that was ever
> stored in Railway.

---

## Architecture

```
Render (Blueprint: render.yaml)
├── control-plane  (cron, 14:30 UTC Mon–Fri)      no port, no inbound
│   ├── ANTHROPIC_API_KEY
│   └── DATABASE_URL       (cp_user)
└── execution      (background worker, always on) no port, no inbound
    ├── ALPACA_KEY / ALPACA_SECRET
    └── EXEC_DATABASE_URL  (exec_user)

Supabase Postgres (Pro): roles cp_role · exec_role · ops_role

Credential isolation invariant (hard — do not relax):
- control-plane: Anthropic + cp_role DB only. Never Alpaca.
- execution: Alpaca + exec_role DB only. Never Anthropic.
```

Render cron and worker service types cannot receive inbound requests, which enforces the
"no public inbound traffic to a credentialed process" invariant at the platform level.

---

## Pre-flight: fresh credentials only

| Credential | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | platform.claude.com → Settings → API keys (new key; revoke any old one; set a low spend limit) |
| `ALPACA_KEY` + `ALPACA_SECRET` | alpaca.markets → Paper Trading → regenerate keys |
| `DATABASE_URL`, `EXEC_DATABASE_URL` | Supabase role URLs (Step 1). Rotate `cp_user`/`exec_user` passwords if ever put in Railway |

Keep them in a password manager. Never put them in a file in the repo.

---

## Step 1 — Supabase (skip if already provisioned)

1. Pro project at supabase.com; wait for provisioning.
2. Run the migrations with the super-user URL (`npm run migrate --workspace @trading-council/db`).
3. Create login users (or rotate their passwords if they exist):
   ```sql
   CREATE USER cp_user   WITH LOGIN PASSWORD '<new>' IN ROLE cp_role;
   CREATE USER exec_user WITH LOGIN PASSWORD '<new>' IN ROLE exec_role;
   GRANT USAGE ON SCHEMA public TO cp_user, exec_user;
   -- rotation: ALTER USER cp_user PASSWORD '<new>';
   ```
4. Use **session-mode** URLs, port **5432** (not 6543):
   `postgres://cp_user:PASSWORD@<host>:5432/postgres` (and `exec_user` for execution).

---

## Step 2 — Deploy on Render

1. Push this branch to GitHub (Render deploys from the repo).
2. Render dashboard → **New → Blueprint** → connect `sandeep-velichety/option-pulse`, branch
   `poc/trading-council`, Blueprint path `render.yaml`.
3. Render lists both services and prompts for every `sync: false` secret:
   - control-plane: `ANTHROPIC_API_KEY`, `DATABASE_URL`
   - execution: `ALPACA_KEY`, `ALPACA_SECRET`, `EXEC_DATABASE_URL`
4. Apply. First Docker build takes ~3–5 minutes per service.

Do not set `ALPACA_*` on control-plane or `ANTHROPIC_*` on execution — the runtime guards at the
top of each `services/*/src/index.ts` throw at boot.

`INITIAL_NAV` should match your Alpaca paper account's starting equity (default $100,000).
`FRED_API_KEY` is optional (execution): unset skips VIX fetching.

---

## Step 3 — One-time database + data fixes (after the Nov 2026 incident review)

1. **Apply migration 002** (`post_mortems`). This database has no `pgmigrations` table, so do **not**
   run `npm run migrate` (it would try to re-run 001). Paste
   [`packages/db/manual/apply_002_post_mortems.sql`](../packages/db/manual/apply_002_post_mortems.sql)
   into the Supabase SQL editor (as `postgres`). It is safe to re-run; the last query should return
   three `true` values.
2. **Set `FRED_API_KEY` on `execution`** (free key at fred.stlouisfed.org → My Account → API Keys).
   Without it every snapshot carries `vix=0, vix_stale_days=999`; the council now reads that as "VIX
   unavailable" rather than a risk signal, but you want the real value.
3. **Crypto exits.** Alpaca paper cannot attach stop-loss/take-profit to crypto, so `control-plane-crypto`
   closes crypto positions itself (stop-loss 5–15% below entry, take-profit 10–40% above, or time exit
   at thesis horizon + 1 day). It ships in **dry-run**: look for `[exits][DRY RUN] would SELL …` in the
   `control-plane-crypto` logs, and when you are happy set `CRYPTO_EXIT_DRY_RUN=false` on that service.
   Until you do, held crypto tickers stay blocked (one position per ticker) and nothing new trades in
   them. Set `CRYPTO_EXITS_ENABLED=false` to turn the whole thing off.

---


## Step 4 — Smoke test

**execution → Logs:**
```
[execution] started
[execution] snapshot written: 5/5 symbols, session=closed
```
A `market_snapshots` row should appear in Supabase within a minute.

**control-plane:** Render → control-plane → **Trigger Run** (works any time; outside
9:30–10:30 ET it logs `outside trading window, skipping cycle`, which still proves boot,
credentials, and DB). During the window expect:
```
[control-plane] cycle start: session=xxx nav=100000.00
[control-plane] journal written: decision=... verdict=... ticker=...
```
A `decisions` row and `agent_runs` rows appear in Supabase. If approved, a bracket order shows
at app.alpaca.markets → Paper Trading → Orders.

---

## Cron schedule notes

`30 14 * * 1-5` (UTC): EST → 9:30 ET, EDT → 10:30 ET; both inside the 9:30–10:30 ET window.
`isInTradingWindow()` in `runCycle()` is a secondary guard. A trade needs a snapshot younger than
30 minutes, which `execution` writes every 5 minutes during market hours.

---

## Monitoring

| What | Where |
|---|---|
| Live logs | Render → service → Logs |
| Decisions | Supabase → `decisions` |
| Daily cost | `SELECT * FROM llm_cost_by_role_day ORDER BY day DESC` |
| Open positions | `SELECT * FROM positions_snapshot ORDER BY as_of DESC LIMIT 1` |
| Trade history | `SELECT * FROM fills ORDER BY filled_at DESC` |
| Alpaca orders | app.alpaca.markets → Paper Trading |

**Daily spend cap:** `DAILY_SPEND_CAP_USD=2.00` — control-plane skips LLM calls once today's
`agent_runs.cost_usd` exceeds it.

**"No trades" checklist:** snapshot fresh? → control-plane run happened inside the window? →
`decisions` rows present (abstain/veto vs. never ran)? → `trade_intents` rows `submitted`? →
execution logs for Alpaca errors.

---

## Stopping the run

Suspend the control-plane cron in Render to stop new decisions; execution can keep running (it
only orders when `trade_intents` appear). To stop everything, suspend or delete both services.

---

## Tracing a cycle (why did / didn't it trade?)

Each control-plane cycle logs one line per stage, tagged `[control-plane][stock]` or `[control-plane][crypto]`
with a short cycle id, and always ends in exactly one terminal line:

| Terminal line | Meaning |
|---|---|
| `done {verdict,...}` | A decision was journaled (approve / reject / abstain / gate_rejected). |
| `skip {reason}` | Deliberate: `outside_trading_window`, `daily_spend_cap_reached`, `no_stock_snapshot_in_db`, `stock_snapshot_stale`, `no_fresh_crypto_snapshot`. |
| `error {stage,...}` | Crashed; `stage` is `spend_cap`, `load_snapshot`, `load_portfolio`, `council` or `journal`, with the error name, message, HTTP status (Anthropic) or Zod issues. |

Stages in between: `start` (UTC + ET clock, window, backend) → `snapshot` → `portfolio` → `allocator` →
`classifiers` → `risk_gate`. If the logs scroll away, failures and stale-data skips are also saved as rows
in `decisions` (`Agent / cycle error`, `Stale market data (cycle skipped)`) and show on the ops-web
`/decisions` page. A boot line (`[control-plane][boot]`) reports which credentials are present (booleans only).
