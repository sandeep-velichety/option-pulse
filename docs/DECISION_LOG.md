# Decision Log — OptionPulse → Trading Council

A chronological record of why this project pivoted, what was decided, and what's
actually been built. Written so this history survives independent of any single
conversation — anyone (or any future session) picking this repo up cold should
be able to read this and understand how we got here.

Companion documents (published as web artifacts, referenced throughout):
- **Council Protocol** — full architecture ADR: agent design, capital/risk framework, adaptive strategy loop, macro data pipeline, phased roadmap
- **Ship Order** — reconciled MVP build plan: verified against the live repo, sequenced into 6 milestones, explicit scope verdict

---

## 1. Starting point: what OptionPulse was

Before any of this, `option-pulse` (still intact on `main`) was a single-page
options-trading **advisory dashboard** — not a trading platform. Node/Express
server (`server.js`, 162 lines) + one 5,040-line `index.html`. It generated
LLM-driven options signals from Alpaca market data and Claude, but never placed
a trade; "paper trades" were self-typed by the user into `localStorage`.

An architecture + backend review of that codebase surfaced real problems, later
folded into the pivot decision:

- **`/api/signals` was a fully open, unauthenticated proxy** to the Anthropic
  API — any caller could control `model`, `max_tokens`, and spend the account's
  API budget.
- **`/api/prices` similarly proxied Alpaca's market-data API unauthenticated**,
  using the *trading* key (data key and trading key are the same key in
  Alpaca) — read-only, but a live example of the coupling that later shaped the
  execution-service design.
- **`/api/health` leaked the first 8 characters of `ALPACA_KEY`** in a public
  response.
- **The VIX calculation was wrong** — it used `VIXY price × 10` as a stand-in
  for the real VIX index (off by roughly 10x), feeding directly into risk-tier
  logic.
- **A full options-chain/Greeks endpoint existed server-side but was never
  called by the frontend** — every IV figure the LLM cited was effectively
  hallucinated.
- **Two dead endpoints** (`/.netlify/functions/signals`) were left over from a
  prior Netlify deployment and silently broken in production.
- The app's catch-all route (`app.get('*')`) returns HTTP 200 (the SPA shell)
  for *any* unmatched path — meaning a missing API endpoint looks like a JSON
  parse error, not a 404. Worth remembering for any future debugging on `main`.

## 2. The pivot decision

Goal: turn this into a fully automated, multi-agent trading system —
council-governed, spanning stocks, crypto, and prediction markets — rather
than an advisory tool a human has to act on manually.

**Early research findings that shaped the design:**

- **Robinhood has no public trading API.** Alpaca is the credible
  programmatic execution path for stocks and crypto; Polymarket has its own
  execution API for prediction markets — but see below.
- **Polymarket's international CLOB is illegal for US persons to trade on**
  (geoblocked since the Jan 2022 CFTC settlement; VPN circumvention violates
  ToS and risks fund forfeiture). Kalshi is the compliant path — CFTC-designated,
  and critically, it has a demo sandbox, which Polymarket US does not.
- **Kalshi bans war/military/violence/assassination markets outright** — a
  CFTC-level policy, not a Kalshi quirk, and increasingly being formalized
  industry-wide. This directly affects the "follow the wars" ask: no compliant
  US venue currently lets you trade war outcomes. Conflict/geopolitical signal
  still flows to the Stock and Crypto specialists as macro context — it just
  never becomes an executable prediction-market position.
- **Polymarket's read-only Gamma API is *not* geoblocked** — only order
  placement is restricted for US users. This unlocked a "best of both" design:
  Polymarket serves as a legal historical/live **reference and calibration
  feed** (bigger, richer catalog), while Kalshi remains the only venue that
  ever holds funds or places an order. See Council Protocol §5.4.1.

## 3. Architecture decisions (Council Protocol)

The full reasoning lives in the Council Protocol artifact; the load-bearing
decisions:

- **The council is not three LLMs voting.** Three roles — Allocator (proposes),
  Risk Officer (checks against hard limits), Adversary (red-teams) — run a
  fixed sequence: propose → parallel critique → one revision → a **code-only**
  veto gate. LLMs argue; a deterministic, unit-tested pure function converts
  the outcome to a dollar amount (fractional Kelly, capped) and a pure-function
  risk gate validates before anything submits. **The LLM never outputs a
  dollar amount and never places an order.**
- **The objective function, in priority order:** (1) never let the account
  reach zero — a hard constraint enforced by circuit breakers, not a soft LLM
  preference; (2) compound small, reliable edges as the primary return
  source; (3) small, capped bets on asymmetric payoffs, opportunistically.
  Every recommendation carries a `bet_class` (`core` vs `asymmetric`) —
  `core` uses quarter-Kelly sizing capped at 5% NAV; `asymmetric` is flat-capped
  at 1% NAV per position (5% aggregate) *regardless of stated conviction*,
  because an LLM's confidence on a true longshot is mostly noise.
- **"Killing an agent" means retiring a strategy version, not the agent.**
  Agents are persistent identities; strategies are versioned policies that
  hold capital. Death = retirement + capital clawback + tombstone + mandatory
  cooldown — real consequences without an unrecoverable system or perverse
  in-context incentives (the existential framing never appears in any prompt).
- **Diversification is enforced as allocation bands in code plus a
  correlation gate** — not a mandate to always be invested. Every sleeve,
  every cycle, is free to hold cash when nothing clears the bar. Abstention is
  a first-class, expected output, not a failure state.
- **The adaptive strategy loop** now includes a per-trade post-mortem
  (classifying every closed position as thesis-right/thesis-wrong/execution-bug/
  lucky-win/resolution-mismatch), a "tune before you replace" step before full
  strategy retirement, and a **Strategy Observatory** — a planned read-only
  dashboard tab for active strategies, performance, failure breakdown, and the
  tombstone graveyard (Tier 2/3 scope, not MVP).

## 4. MVP specification (Ship Order)

Four specialist passes (software architecture, backend, frontend, devops) each
broke Tier 0 into development stories; **enterprise-cto then verified every
claim against the live repo** before reconciling them — this caught real bugs
the four lanes missed individually:

- Frontend's dead-code count was wrong (2 live Netlify calls, not 5).
- Two exposures nobody had individually flagged as severely as they warranted:
  `/api/signals` is a full public Anthropic **gateway**, not just a spend risk;
  `/api/prices` leaks the Alpaca trading key.
- **`/api/ops/*` had no owner** in a two-headless-process topology — resolved
  by adding a third minimal `ops-web` service holding SELECT-only DB
  credentials, no Alpaca or Anthropic keys.
- **`trade_intents`** — the entire inter-process communication mechanism —
  was missing from the backend's actual schema. Added.
- Reconciliation had been specified three separate times across three lanes as
  if they were three features; consolidated into one module, three triggers.

**Supabase decision** (mid-review pivot from plain Postgres): Pro tier (Free
has zero backup retention and pauses after ~7 days idle — incompatible with a
30-day unattended run), Supavisor **session-mode** pooling (this is long-lived
cron/worker processes, not a serverless fleet — transaction mode would disable
prepared statements and break the advisory-lock scheduler guard), `node-pg-migrate`
over Prisma or the Supabase CLI, and an explicit **no** on using Supabase's
auto-generated Data API/RLS for the ops page — it would reintroduce the exact
"public endpoint, weak guard" failure mode this whole pivot exists to fix.

**Sign-off:** approved to build, conditional on three additions (a backup
restore drill, halt-state transition alerting, and explicit UTC/DST discipline
in the scheduler) plus the key-rotation/deployment-teardown steps happening
first. Framing for all future scope questions: *the 30-day unattended clock is
the critical path, not the feature set* — the only test for adding anything
else is whether it must exist before the clock starts or can land while it's
already running.

## 5. What's actually been built

**2026-08-30 — Branch created, legacy code removed, monorepo scaffolded.**

Per user decision: `main` stays untouched (still the live-on-GitHub OptionPulse
dashboard); all new work happens on `poc/trading-council`, pushed to `origin`.

- `0115989` — removed `server.js`, `public/index.html`, `railway.json`,
  `package.json` (the CTO review found nothing in the legacy codebase worth
  preserving beyond the Alpaca fetch shape and Anthropic call plumbing, both
  small enough to rewrite cleanly).
- `7487ac5` — scaffolded the npm-workspaces monorepo per Ship Order Milestone 1:
  - `packages/contracts` — Zod schemas for all five inter-service contracts
    (`MarketSnapshot`, `StockRecommendation`, `CouncilVerdict`, `TradeIntent`,
    `GateResult`), including the numeric-range validation layer (conviction
    0–1, horizon-day bounds) that Anthropic's structured-output JSON Schema
    cannot express on its own.
  - `packages/db` — migration tooling wired (`node-pg-migrate`), no migrations
    written yet — blocked on a live Supabase project connection string.
  - `services/control-plane`, `services/execution`, `services/ops-web` — each
    boots to a stub that **asserts its own credential isolation at runtime**
    (e.g. `control-plane` throws immediately if `ALPACA_KEY` is present in its
    environment) — enforcing the "no process holding a broker or LLM
    credential accepts public inbound traffic" invariant from day one, not as
    an afterthought.
  - Verified before committing: `npm run typecheck` and `npm run build` pass
    clean across every workspace; all three services boot and exit cleanly;
    the credential guards were manually triggered and confirmed to throw;
    `StockRecommendation` was fed `conviction: 1.7` and correctly rejected it.

**2026-08-30 — Railway deployment discussed, not yet executed.**

Plan: one Railway project, three services, using Railway's monorepo
root-directory support — `control-plane` as a native **Railway Cron Job**
(not a persistent process, sidestepping the "redeploy silently skips a
scheduled fire" risk), `execution` and `ops-web` as persistent services, no
public domain on `control-plane` or `execution`. Caveat: Railway evaluates
cron schedules in **UTC only** — the plan is to have the job check
`America/New_York` local time on wake and no-op outside the intended window,
rather than hardcode a UTC offset that drifts across the DST boundary the
30-day run will cross.

**Not yet done:** Railway CLI is installed but unauthenticated on this
machine (`railway login` requires an interactive browser flow only the user
can complete) — config files not yet written, nothing provisioned.

**2026-09-01 — Standing process rule + architecture/deployment/interaction docs.**

- Added `CLAUDE.md` with a standing instruction: update this file at the end
  of every session that makes a real change, and a restatement of the
  credential-isolation invariant so it's enforced regardless of which session
  or agent touches the code.
- Added three diagram-level docs, all Mermaid (renders natively on GitHub),
  kept in-repo for the same reason this log is — they don't depend on the
  Council Protocol / Ship Order web artifacts staying reachable:
  - `docs/ARCHITECTURE.md` — component diagram (services, Supabase tables,
    external APIs, the "no public inbound traffic to a credentialed service"
    invariant drawn explicitly), the credential/DB-role matrix, a full
    decision-loop sequence diagram (scheduler → specialist → council →
    sizer → gate → `trade_intents` → execution → Alpaca → reconciliation),
    and a live-vs-planned status table by architectural layer.
  - `docs/DEPLOYMENT.md` — the Railway topology from the prior discussion,
    now diagrammed: one project, three services, `control-plane` as a native
    Railway Cron Job (not persistent) specifically to avoid the "redeploy
    silently skips a scheduled fire" risk, no public domain on
    `control-plane`/`execution`. Documents the UTC-only cron caveat and the
    App-side `America/New_York` window check that resolves it.
  - `docs/USER_INTERACTION.md` — the operator interaction model: a routine
    diagram (no action needed), an exception diagram (alert → investigate →
    maybe act), and a table mapping every trigger to whether a human sign-off
    is mandatory (L3/L4 circuit breakers and strategy promotion always are,
    per Council Protocol §3.11/§4.3 — no automated path resumes trading after
    a portfolio-level halt).
- No code changed in this pass — documentation only.

## 6. Current status / what's next

| Milestone | Status |
|---|---|
| M0 — Key rotation, delete old Railway deployment | **Not yet done** — do this before anything touches real capital |
| M1 — Foundations | Mostly done: monorepo, contracts, service stubs, credential guards. Remaining: Supabase project provisioning, migration 001, CI workflow content (a skeleton exists at `.github/workflows/ci.yml`) |
| M2 — Audit spine & safety primitives | Not started — blocked on Supabase |
| M3 — Deterministic core (sizer, risk gate) | Not started — no external dependency, can start any time |
| M4 — Execution service | Not started |
| M5 — Control plane (specialist, council, scheduler) | Not started |
| M6 — Observability & go-live | Not started |

Open decisions still on the table: whether to provision Supabase and Railway
now (both need the user's own account access), and whether `ops-web` runs as
a hosted Railway service or locally on-demand for the 30-day window (Ship
Order's "push for urgent, pull for detail" framing leaves this either way).
