# trading-council

A multi-agent automated trading system: specialist LLM agents (stocks, crypto,
Kalshi prediction markets) produce recommendations; a three-role council
(Allocator / Risk Officer / Adversary) decides via a deterministic, non-LLM
sizer and risk gate; a credential-isolated execution service places trades.
No LLM ever outputs a dollar amount or places an order.

This branch (`poc/trading-council`) starts the build from a clean slate —
`main` still holds the original OptionPulse dashboard.

**Design docs (source of truth):**
- **Council Protocol** — architecture, agent knowledge requirements, risk framework, phased roadmap
- **Ship Order** — reconciled MVP build plan: verified against the live repo, sequenced into 6 milestones, with an explicit scope verdict

## Structure

```
packages/
  contracts/   Zod schemas shared by every service: MarketSnapshot,
               StockRecommendation, CouncilVerdict, TradeIntent, GateResult
  db/          Postgres (Supabase) migrations — not yet wired, needs a
               live Supabase project connection string first

services/
  control-plane/   Scheduler, specialist agent, council, sizer, journal.
                   Holds ANTHROPIC_API_KEY only. No Alpaca credentials,
                   no public inbound traffic.
  execution/       Alpaca client, risk gate, order submission,
                   reconciliation, NAV tracker. Holds ALPACA_KEY/SECRET
                   only. No LLM dependency, no public inbound traffic.
  ops-web/         Read-only visibility page + 3 JSON endpoints. SELECT-only
                   DB credentials. No Alpaca or Anthropic keys, no write path.
```

**Hard invariant:** no process holding a broker or LLM credential accepts
inbound traffic from the public internet. control-plane and execution-service
communicate only through the database (`market_snapshots`, `trade_intents`),
never HTTP.

## Status

Foundations scaffolded (Ship Order Milestone 1). Not yet functional — see
Ship Order for the milestone sequence (M0 key rotation → M1 foundations →
M2 audit spine/safety → M3 deterministic core → M4 execution → M5 control
plane → M6 observability/go-live).

## Setup

```
npm install
cp .env.example .env   # fill in credentials per service, see comments
```

Nothing runs end-to-end yet — each service currently boots to a stub that
asserts its own credential isolation and exits.
