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

**2026-09-01 (cont'd) — RAG feasibility review; LLM token/prompt observability designed.**

- Ran a three-specialist review (backend-systems-architect, software-architect,
  enterprise-cto) on whether to build a RAG pipeline (embeddings + vector
  search) for the planned macro pipeline, agent memory store, post-mortem
  lessons, and strategy graveyard. **Unanimous defer.** Key reasons: the
  system's identical per-day `MacroContext` is a perfect prompt-cache prefix
  on `claude-opus-5` — per-agent semantic retrieval would break that caching
  for worse determinism; Anthropic's own Managed-Agents memory store uses
  plain file-based `grep`/`glob`, not vector search, for the same use case;
  every candidate consumer is Tier 2/3 and unbuilt, failing the "must exist
  before the clock starts" test cleanly; and unlike the deadman switch/spend
  cap (cheap now, expensive later), RAG is expensive now and cheap to add
  later (`CREATE EXTENSION vector` plus a column, once real data exists).
  **The one time-sensitive piece:** whatever tables the macro/memory/post-mortem
  data lands in must retain raw source text verbatim (not just a derived
  summary) plus a stable id/`created_at`/`kind` discriminator and a JSONB
  tags column — a schema decision, free now, that forecloses nothing later.
  Concrete revisit triggers: assembled knowledge block exceeds ~50k tokens in
  a single prompt, post-mortem lessons exceed ~200 records, or a second
  hand-written heuristic is needed to decide which tagged lessons to include.
- Discussed whether Kalshi/Alpaca/crypto integration should go through an
  MCP server or Claude Code Skills rather than plain in-code API calls.
  **Resolved: production order execution stays traditional in-code API
  calls — not actually an open question, since it follows directly from the
  existing "LLM never places an order" credential-isolation invariant
  (Council Protocol §5.1). An MCP server giving an LLM live tool-calling
  access to submit orders would reopen exactly the prompt-injection blast
  radius that invariant exists to close.** Live MCP/tool access mid-reasoning
  is also a poor fit for the specialist agent's market-data reads specifically
  because `MarketSnapshot` is pre-fetched and hashed (`input_hash`) so every
  decision is reconstructable from an exact, immutable input — live tool
  calls would break that audit guarantee. Where MCP/Skills *do* fit: purely
  as dev-time tooling (querying paper accounts, inspecting sandbox endpoints
  while building `services/execution`), separate from the shipped system, and
  as reference Skills (curated API knowledge — auth, gotchas, rate limits) to
  help write the traditional integration code accurately. Neither built yet.
- **Designed (not yet migrated) LLM token/prompt observability**: extended
  the `agent_runs` schema with `prompt_version_hash`, `messages` (the exact
  rendered prompt sent), `effort`, `stop_reason`, and full token/cost columns
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cost_usd`); added a `prompt_versions` table
  to dedupe system prompts (a new hash marks exactly when a prompt changed);
  added an `llm_cost_by_role_day` aggregation view, including a cache-hit-ratio
  column that doubles as an early warning if the `MacroContext` caching
  benefit above ever regresses. Rationale: this is one-way — token/prompt
  data can't be recovered for calls that already happened, so it ships in
  migration 001 with everything else, not bolted on later. Full design in
  `docs/ARCHITECTURE.md`; `packages/db/README.md` updated so migration 001
  doesn't miss it.

**2026-09-24 — M3: Kelly sizer + risk gate implemented; TimesFM architecture decided.**

- Added `packages/sizer` — pure TypeScript module, no external runtime dependencies.
  - `kellySizer(recommendation, convictionAdjustment, nav, asymmetricNotionalOpen) → SizerOutput`
    — fractional Kelly (f* = edge / variance_period), then quarter-Kelly for `core` bets capped
    at 5% NAV, flat 1% NAV for `asymmetric` bets (5% aggregate cap); five `cap_applied` paths
    (`none`, `kelly_cap`, `floor`, `asym_flat_cap`, `asym_aggregate_cap`).
  - `riskGate(intent, snapshot, portfolio, config?) → GateResult` — nine named checks
    (`market_open`, `symbol_tradable`, `circuit_breaker_clear`, `daily_loss_limit`,
    `portfolio_drawdown`, `no_duplicate_intent`, `notional_positive`, `notional_hard_cap`,
    plus `asym_aggregate_ok` for asymmetric positions); returns ALL results not just first
    failure; validates final output through the `GateResult` Zod schema before returning.
  - 29 unit tests covering all cap paths, edge cases (negative edge, zero variance,
    conviction clamping, aggregate exhaustion), and all gate failure modes including
    multi-failure reporting; `vitest run` passes clean.
- Added optional `fm_forecast` field to `SymbolSnapshot` in `packages/contracts/src/market-snapshot.ts`
  — `{ point, q10, q90, horizon_days } | null | undefined`. Null when the forecaster service
  is not running; specialists must handle both cases. Backwards-compatible (optional field).
- **TimesFM architecture decision.** The timeseries foundation model (Google TimesFM,
  ~200M params) will run as a separate `services/forecaster` Python sidecar on Railway.
  TypeScript cannot run PyTorch natively; the CPU-only MLX variant is Apple Silicon only and
  not deployable on Railway's Linux workers. The forecaster accepts a price series over
  internal HTTP (no public domain), returns FM quantile forecasts, and `control-plane` calls
  it during snapshot assembly. **No new council agent:** the FM output is structured numeric
  data fed as a field in `MarketSnapshot`, not a council vote — existing specialists incorporate
  it in their prompts. Revisit a dedicated Quant Specialist seat in Tier 2 if independent FM
  argumentation in the council becomes valuable. `services/forecaster` and the snapshot
  assembly call are Tier 2 scope; the schema slot is free and the decision is made.

**2026-09-25 — M5: Control-plane implemented (hybrid Jev + Anthropic council).**

Decided to use **Jev** (TypeSafe AI, `@typesafe-ai/sdk ^0.6.0`) as the decision classifier for
the Risk Officer and Adversary council seats, with Anthropic (`claude-sonnet-4-6`) retained for
the Allocator (initial thesis + revision pass). Jev is a "System One Model" — not an LLM; it
takes a structured state + named questions and returns calibrated probability answers
(`noul`, `choice`, `score`) at 70–500ms latency and ~400x lower cost than frontier LLMs.

**Why Jev for Risk Officer and Adversary, Anthropic for Allocator:**
- Allocator needs free-form narrative reasoning: catalysts, macro context, qualitative thesis
  synthesis — this is a generation task that requires a language model.
- Risk Officer and Adversary return binary verdicts (veto: yes/no) with a category. That is
  a classification task — exactly Jev's intended use case. No free-form text generation required.
- `codeVetoGate()` remains a pure function: `approve` iff neither Jev classifier fires veto.
- When a veto fires, the Allocator gets one revision pass (second Anthropic call) to decide
  whether to maintain or withdraw the recommendation.
- On clean sessions (no veto): 1 Anthropic call + 2 Jev calls. On vetoed sessions: 2 Anthropic
  calls + 2 Jev calls.

Built the full `services/control-plane` service in 10 TypeScript modules. Typecheck clean.

- `src/types.ts` — shared internal types: `AgentRunRecord`, `PendingIntentData`, `SessionResult`.
- `src/db.ts` — `pg.Pool` wired to `DATABASE_URL`, cp_role credentials.
- `src/anthropic-client.ts` — Anthropic singleton + `computeAnthropicCost()` (pricing for
  `claude-sonnet-4-6`).
- `src/jev.ts` — `TypeSafeClient` singleton; `callJevAdversary()` and `callJevRiskOfficer()`.
  Both use `noul()` for veto probability, `choice()` for category classification.
  Token counts from `response.usage.input_tokens` (not estimated).
- `src/prompts.ts` — Allocator system prompts, RECOMMENDATION_TOOL and REVISION_TOOL JSON
  Schema definitions for Anthropic tool_use.
- `src/allocator.ts` — `callAllocator()` (initial thesis, forced tool_use → `StockRecommendation`
  Zod parse) and `callAllocatorRevision()` (revision pass with Jev critique context).
- `src/council.ts` — `runCouncil()`: Allocator → parallel Jev classifiers →
  `codeVetoGate()` → optional Allocator revision → `kellySizer()` → `riskGate()` → assembles
  `SessionResult` including `PendingIntentData` if approved.
- `src/journal.ts` — `writeJournal()`: upserts `prompt_versions`; then in one deferred-FK
  transaction: INSERT all `agent_runs` rows (deferred FK), INSERT `decisions`, INSERT
  `trade_intents` if approved; `ensureStrategy()` creates the default strategy on first run.
- `src/scheduler.ts` — `runCycle()`: ET window check (9:30–10:30 AM weekdays), snapshot
  staleness check (30-min threshold), daily spend cap check (default $2/day), loads portfolio
  state from DB, calls `runCouncil()` + `writeJournal()`.
- `src/index.ts` — credential guard (Alpaca keys must be absent), cron
  `* 9,10 * * 1-5 America/New_York` (minute-level), SIGTERM handler, `RUN_ONCE=true` mode
  for smoke tests.

**Env vars required:** `DATABASE_URL`, `ANTHROPIC_API_KEY`,
`WATCH_SYMBOLS` (comma-separated), `INITIAL_NAV` (default 100000), `DAILY_SPEND_CAP_USD`
(default 2.00), `ANTHROPIC_MODEL` (default claude-sonnet-4-6).
`TYPESAFE_API_KEY` is optional (only consumed when `USE_JEV=true`; see 2026-09-26 entry).

**2026-09-26 — USE_JEV feature flag; LLM-based classifier fallback; Jev stripped from deployment docs.**

TypeSafe AI paused new signups, making `TYPESAFE_API_KEY` unavailable to deploy.

**Decision:** add `USE_JEV` env-var feature flag (default `false`) with a clean fallback path so the
system deploys and runs without any Jev credentials. The flag is not a temporary hack — Jev's System
One classifier is still the intended production path when signups reopen; the flag selects between
two implementations of the same interface.

**Changes:**
- `src/types.ts` — added shared `AdversaryResult` and `RiskOfficerResult` interfaces (previously Jev-specific).
- `src/jev.ts` — converted top-level credential check to **lazy init** (`getJev()` helper). Module
  loads cleanly when `USE_JEV=false`; TYPESAFE_API_KEY is only read if `getJev()` is actually called.
- `src/prompts.ts` — added `ADVERSARY_SYSTEM_PROMPT`, `ADVERSARY_TOOL`, `RISK_OFFICER_SYSTEM_PROMPT`,
  `RISK_OFFICER_TOOL` for the LLM fallback path.
- `src/llm-classifiers.ts` — new module: `callLlmAdversary()` and `callLlmRiskOfficer()` using
  Anthropic `tool_use` forced-tool-call mode. Returns the same `AdversaryResult`/`RiskOfficerResult`
  shapes as the Jev path. `veto_confidence` is `0.9`/`0.1` (LLM gives binary, not calibrated prob).
- `src/classifiers.ts` — new routing module: reads `USE_JEV`, dynamically imports either `jev.ts` or
  `llm-classifiers.ts` so the unused SDK is never loaded. Exports `callAdversary()`, `callRiskOfficer()`,
  `classifierBackend()`.
- `src/council.ts` — replaced `buildJevAgentRunRecord` (hard-coded `JEV_MODEL`) with
  `buildClassifierAgentRunRecord` (uses `classifierBackend()` for the `model` field and `role` tag).
  Calls `callAdversary()`/`callRiskOfficer()` from `classifiers.ts`. Typecheck clean.
- `docs/DEPLOYMENT.md` — removed `TYPESAFE_API_KEY` from architecture diagram, pre-flight checklist,
  and control-plane env vars table. Left a commented `USE_JEV=true` hint for when it reopens.
- `.env.example` — removed `TYPESAFE_API_KEY` from required section; added `USE_JEV=false` with a
  comment explaining when to flip it.

**Cost on default path (USE_JEV=false):**
- Clean session (no veto): 3 Anthropic calls (Allocator + LLM Adversary + LLM Risk Officer).
- Vetoed session: 4 Anthropic calls (+ Allocator revision).
- When `USE_JEV=true`: 1 Anthropic call (Allocator) + 2 Jev calls; vetoed: 2 + 2.

**2026-09-24 (cont'd) — M4: Execution service implemented.**

Built the full `services/execution` service in 10 TypeScript modules. All typecheck clean;
`npm run build --workspaces --if-present` passes.

- `src/db.ts` — `pg.Pool` wired to `EXEC_DATABASE_URL`, max 5 connections, idle-client error logging.
- `src/alpaca.ts` — `Alpaca` client from `ALPACA_KEY`/`ALPACA_SECRET`, paper mode default, exposes
  the client for all other modules.
- `src/compute-technicals.ts` — pure functions, no dependencies: `ma`, `atr14`, `realizedVol20d`,
  `volumeZ20d`, `adv20d`. Handles null-returns for insufficient data throughout.
- `src/snapshot-writer.ts` — `writeSnapshot()`: fetches 210 daily bars per symbol from Alpaca
  Data, computes all technicals, fetches asset metadata, optionally pulls VIX from FRED, builds and
  validates a `MarketSnapshot` via Zod, SHA-256 hashes it, inserts into `market_snapshots`.
- `src/claim-loop.ts` — `claimAndSubmit()`: `BEGIN … SELECT … FOR UPDATE SKIP LOCKED` (up to 5
  intents per tick) → mark `claimed` → `COMMIT` → submit each outside the transaction. ROLLBACK on
  any transaction error; never throws (loop must stay alive).
- `src/order-submitter.ts` — `submitOrder(row)`: Zod-parses the DB row into `TradeIntent`; refuses
  any `APP_MODE` other than `paper`; calls `alpaca.trading.orders.bracket()`; writes to `orders`
  table; updates intent to `submitted`. On Alpaca error: marks intent `failed`, logs, does not throw.
- `src/fill-writer.ts` — `handleFill(update)`: ignores non-fill events and non-council orders;
  writes to `fills`; then does an authoritative position + account fetch and writes
  `positions_snapshot` (with asymmetric notional from open intents) and `nav_history` (peak NAV
  tracking, drawdown, daily PnL, halt_level=0 placeholder). All on fill, not on poll.
- `src/trade-stream.ts` — `startTradeStream()`/`stopStream()`: opens `TradingStream` via
  `alpaca.trading.stream()`, subscribes to trade updates, routes to `handleFill`. Uses
  `connect()`/`disconnect()` (not the non-existent `close()` — confirmed against SDK types).
- `src/reconciliation.ts` — `runEodReconciliation()`: authoritative position + NAV snapshot,
  source='eod_reconcile'; marks expired pending/claimed intents as rejected; logs summary.
- `src/index.ts` — orchestration: credential guard (Anthropic key must be absent); env-var
  validation; starts trade stream; sets up 2-second claim-loop interval; cron `*/5 9-16 * * 1-5`
  ET for snapshot writes (+ immediate boot snapshot); cron `35 16 * * 1-5` ET for EOD
  reconciliation; SIGTERM handler clears interval, disconnects stream, drains pool.

**Implementation notes:**
- The Alpaca `Bar` SDK type (`timestamp: Date, open, high, low, close, volume`) differs from the
  contracts `Bar` type (`t, o, h, l, c, v`) — mapped explicitly in `snapshot-writer.ts`.
- `TradingStream` is accessed via `streaming.TradingStream` namespace (not a direct named export)
  — the linter confirmed the import pattern.
- `TimeFrame.Day` used for the bar timeframe parameter — it's a branded `TimeFrameString`, not a
  plain string literal, so the named constant is required.
- `Position.symbol` (not `.ticker`) and `Account.lastEquity` (camelCase) are the correct field
  names per SDK types.

## 6. Current status / what's next

| Milestone | Status |
|---|---|
| M0 — Key rotation, delete old Railway deployment | **Not yet done** — do this before anything touches real capital |
| M1 — Foundations | Mostly done: monorepo, contracts, service stubs, credential guards. Remaining: Supabase project provisioning, migration 001, CI workflow content (a skeleton exists at `.github/workflows/ci.yml`) |
| M2 — Audit spine & safety primitives | Not started — blocked on Supabase |
| M3 — Deterministic core (sizer, risk gate) | **Done** — `packages/sizer`, 29 tests passing |
| M4 — Execution service | **Done** — 10 modules, typecheck clean, all workspaces build |
| M5 — Control plane (specialist, council, scheduler) | **Done** — 10 modules, typecheck clean; hybrid Jev + Anthropic council; USE_JEV flag added (default false, LLM fallback active) |
| M6 — Observability & go-live | Not started |

Open decisions still on the table: whether to provision Supabase and Railway
now (both need the user's own account access), and whether `ops-web` runs as
a hosted Railway service or locally on-demand for the 30-day window (Ship
Order's "push for urgent, pull for detail" framing leaves this either way).
