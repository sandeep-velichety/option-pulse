# Deployment Guide — 30-day paper trading run

Two services deploy to Railway: **execution** (long-running worker) and **control-plane** (daily cron job).
Both read/write a shared **Supabase** Postgres database through separate DB roles.

---

## Architecture

```
Railway project: trading-council
├── control-plane  (Cron Job, fires 14:30 UTC Mon–Fri)
│   ├── ANTHROPIC_API_KEY
│   └── DATABASE_URL  (cp_role, session-mode Supavisor)
└── execution      (Persistent Worker, always running)
    ├── ALPACA_KEY / ALPACA_SECRET
    └── EXEC_DATABASE_URL  (exec_role, session-mode Supavisor)

Supabase Postgres (Pro tier)
└── Three roles: cp_role · exec_role · ops_role
    Each role has its own Supavisor session-mode connection string.

Credential isolation invariant (hard — do not relax):
- control-plane: Anthropic + cp_role DB only. Never Alpaca.
- execution: Alpaca + exec_role DB only. Never Anthropic.
```

---

## Pre-flight checklist

Before touching Railway or Supabase you need four credentials:

| Credential | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | platform.claude.com → Settings → API keys |
| `ALPACA_KEY` + `ALPACA_SECRET` | alpaca.markets → Paper Trading → API keys (rotate the old one first — M0) |

Keep these in a password manager. Do **not** put them in any file in the repo.

---

## Step 1 — Supabase (15 minutes)

1. Create a new project at supabase.com (**Pro tier** — needed for Supavisor pooler and connection limits).
2. Wait for the project to finish provisioning (~2 minutes).
3. Go to **Project Settings → Database → Connection string**.
4. Copy the **Session mode** connection strings for each role.  
   The base URL looks like: `postgres://postgres.xxxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres`

   You need **three** connection strings — one for each DB role. To get role-scoped URLs:
   - Supabase creates one super-user URL by default. Run the migration first (next step), then
     Supabase creates `cp_role`, `exec_role`, `ops_role` as Postgres roles.
   - After migration: in Supabase SQL editor, create login users that inherit the roles:
     ```sql
     -- Run once after migration 001 completes
     CREATE USER cp_user  WITH LOGIN PASSWORD 'choose-a-password' IN ROLE cp_role;
     CREATE USER exec_user WITH LOGIN PASSWORD 'choose-a-password' IN ROLE exec_role;
     CREATE USER ops_user  WITH LOGIN PASSWORD 'choose-a-password' IN ROLE ops_role;
     GRANT USAGE ON SCHEMA public TO cp_user, exec_user, ops_user;
     ```
   - Then build URLs:
     - `DATABASE_URL`     = `postgres://cp_user:PASSWORD@<host>:5432/postgres`
     - `EXEC_DATABASE_URL` = `postgres://exec_user:PASSWORD@<host>:5432/postgres`
     - `OPS_DATABASE_URL`  = `postgres://ops_user:PASSWORD@<host>:5432/postgres`
   - **Port 5432** = Supavisor session mode (required for long-lived workers). Not 6543 (transaction mode).

---

## Step 2 — Run the migration (5 minutes)

Run migration 001 against Supabase using the **super-user** URL (not a role-scoped URL):

```bash
# In the repo root — use the postgres super-user URL from Supabase dashboard
DATABASE_URL="postgres://postgres.xxxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  npm run migrate --workspace @trading-council/db
```

Expected output: `Migrated up: 001_initial_schema`

Verify in Supabase Table Editor: you should see 10 tables including `decisions`, `agent_runs`, `trade_intents`.

After migration, run the SQL above to create the role-scoped login users.

---

## Step 3 — Railway project (20 minutes)

### 3a. Create the project

```bash
railway login      # opens browser — log in with your Railway account
railway init       # creates a new project; name it "trading-council"
```

### 3b. Add the control-plane service

In Railway dashboard → your project → **New Service** → **GitHub Repo** → select `option-pulse`:

| Setting | Value |
|---|---|
| **Root Directory** | *(leave blank — repo root)* |
| **Dockerfile Path** | `Dockerfile.control-plane` |
| **Service Config Path** | `services/control-plane/railway.toml` |

Railway will detect `cronSchedule` in the toml and automatically set the service type to **Cron Job**.

### 3c. Add the execution service

**New Service** → same GitHub repo:

| Setting | Value |
|---|---|
| **Root Directory** | *(leave blank — repo root)* |
| **Dockerfile Path** | `Dockerfile.execution` |
| **Service Config Path** | `services/execution/railway.toml` |

This becomes a **Persistent Worker** (always running).

---

## Step 4 — Environment variables

Set these in Railway dashboard (each service has its own Variables tab):

### control-plane
```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgres://cp_user:PASSWORD@...
WATCH_SYMBOLS=AAPL,MSFT,NVDA,TSLA,SPY
INITIAL_NAV=100000
DAILY_SPEND_CAP_USD=2.00
RUN_ONCE=true
NODE_ENV=production
APP_MODE=paper
# USE_JEV=true   # optional: set when TypeSafe AI signups reopen (requires TYPESAFE_API_KEY)
```

`INITIAL_NAV` should match your Alpaca paper account's starting equity (default is $100,000).

### execution
```
ALPACA_KEY=PK...
ALPACA_SECRET=...
ALPACA_PAPER=true
EXEC_DATABASE_URL=postgres://exec_user:PASSWORD@...
WATCH_SYMBOLS=AAPL,MSFT,NVDA,TSLA,SPY
NODE_ENV=production
APP_MODE=paper
```

`FRED_API_KEY` is optional — leave it unset to skip VIX fetching (VIX will default to 0 and `vix_stale_days=999`).

---

## Step 5 — Deploy

```bash
git push  # Railway auto-deploys on push to poc/trading-council
```

Or trigger manually in Railway dashboard → **Deploy**.

Watch Railway's build logs — first build takes ~3–5 minutes (Docker layer caching kicks in on subsequent deploys).

---

## Step 6 — Smoke test

After both services show **Active** in Railway:

**Check execution service logs** (Railway → execution → Logs):
```
[execution] started
[execution] snapshot written: 5/5 symbols, session=closed
```
A `market_snapshots` row should appear in Supabase Table Editor within 30 seconds.

**Check control-plane** next morning at 14:30 UTC (9:30 AM EST / 10:30 AM EDT):
```
[control-plane] boot
[control-plane] cycle start: session=xxx nav=100000.00
[control-plane] journal written: decision=... verdict=... ticker=...
```
A `decisions` row and `agent_runs` rows appear in Supabase.

**Check Alpaca paper dashboard** (app.alpaca.markets → Paper Trading → Orders):  
If the council approved a trade, a bracket order appears.

---

## Cron schedule notes

`control-plane` fires at **14:30 UTC, Mon–Fri**:
- Winter (EST = UTC-5): 14:30 UTC = **9:30 AM ET** — within the 9:30–10:30 ET window ✓
- Summer (EDT = UTC-4): 14:30 UTC = **10:30 AM ET** — within the 9:30–10:30 ET window ✓

The `isInTradingWindow()` check in `runCycle()` is a secondary guard. The cron entry itself is correct for both DST states with a single UTC time.

---

## Monitoring the 30-day run

| What | Where |
|---|---|
| Live logs | Railway → service → Logs |
| Decisions table | Supabase Table Editor → `decisions` |
| Daily cost | Supabase SQL: `SELECT * FROM llm_cost_by_role_day ORDER BY day DESC` |
| Open positions | Supabase: `SELECT * FROM positions_snapshot ORDER BY as_of DESC LIMIT 1` |
| Trade history | Supabase: `SELECT * FROM fills ORDER BY filled_at DESC` |
| Alpaca orders | app.alpaca.markets → Paper Trading |

**Daily spend cap:** `DAILY_SPEND_CAP_USD=2.00` → control-plane skips the LLM calls if today's `agent_runs.cost_usd` sum exceeds $2. Adjust in Railway env vars if needed.

---

## Stopping the run

To stop cleanly: in Railway, **pause** or **delete** the control-plane cron job. The execution service can keep running (it only places orders when trade_intents appear).

To stop everything: Railway → project → **Delete Project** (or pause both services).
