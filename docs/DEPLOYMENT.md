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

## Step 3 — Smoke test

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
