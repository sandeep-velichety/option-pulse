# Architecture

Companion to [Council Protocol](DECISION_LOG.md#3-architecture-decisions-council-protocol)
and [Ship Order](DECISION_LOG.md#4-mvp-specification-ship-order) — this doc is
the diagram-level view of the same decisions, kept in-repo so it renders
directly on GitHub and doesn't depend on the web artifacts staying reachable.

## System components (Tier 0)

```mermaid
graph TB
    Operator["Operator (browser)"]

    subgraph Railway["Railway project"]
        CP["control-plane<br/>(Cron Job)<br/>holds: ANTHROPIC_API_KEY, cp_role DB"]
        EXE["execution<br/>(persistent)<br/>holds: ALPACA_KEY/SECRET, exec_role DB"]
        OPS["ops-web<br/>(persistent)<br/>holds: ops_role DB (SELECT only)"]
    end

    subgraph Supabase["Supabase Postgres (paper schema)"]
        T1[("decisions, agent_runs<br/>(audit journal, append-only)")]
        T2[("trade_intents<br/>(claim queue)")]
        T3[("market_snapshots")]
        T4[("orders, fills,<br/>positions_snapshot, nav_history")]
        T5[("strategies<br/>(registry + tombstones)")]
    end

    Anthropic["Anthropic API<br/>(claude-opus-5)"]
    Alpaca["Alpaca API<br/>(paper trading)"]
    Kalshi["Kalshi API<br/>(Tier 1)"]
    Polymarket["Polymarket Gamma API<br/>(read-only reference, Tier 1)"]

    Operator -- "HTTPS (only public entry point)" --> OPS
    OPS -- "SELECT only" --> T1
    OPS -- "SELECT only" --> T4

    CP -- "reads (fresh or refuse)" --> T3
    CP -- "writes" --> T1
    CP -- "writes (status=pending)" --> T2
    CP -- "specialist + council calls" --> Anthropic

    EXE -- "SELECT ... FOR UPDATE SKIP LOCKED" --> T2
    EXE -- "writes" --> T3
    EXE -- "writes" --> T4
    EXE -- "reads/updates" --> T5
    EXE -- "orders, fills, market data" --> Alpaca
    EXE -. "Tier 1" .-> Kalshi
    CP -. "Tier 1 prediction specialist" .-> Polymarket

    style CP fill:#1e7f70,color:#fff
    style EXE fill:#1e7f70,color:#fff
    style OPS fill:#4a5560,color:#fff
```

**The invariant this diagram exists to enforce:** no arrow points from the
public internet into `control-plane` or `execution`. The only public entry
point is `ops-web`, and it holds no broker or LLM credential — a full
compromise of `ops-web` yields read access to already-public-adjacent
account state, never a credential that can move money or spend API budget.

`control-plane` and `execution` never call each other over HTTP. They
communicate exclusively through the database: `execution` writes
`market_snapshots` slightly ahead of the decision cycle; `control-plane`
reads the latest row and refuses to proceed if it's stale, rather than
fetching market data directly (which would require `control-plane` to hold
Alpaca credentials, since the data key and trading key are the same key).

## Credential / DB-role matrix

| Service | External credential | DB role | Grants |
|---|---|---|---|
| `control-plane` | `ANTHROPIC_API_KEY` | `cp_role` | INSERT/SELECT `agent_runs`, `decisions`, `trade_intents`; SELECT `nav_history`, `positions_snapshot`, `market_snapshots` |
| `execution` | `ALPACA_KEY`, `ALPACA_SECRET` | `exec_role` | SELECT/UPDATE `trade_intents`; INSERT `orders`, `fills`, `nav_history`, `positions_snapshot`, `market_snapshots` |
| `ops-web` | none | `ops_role` | SELECT only, all tables |

`decisions` and `fills` have `UPDATE, DELETE` revoked from all three roles at
the database level — the append-only audit design is a database-enforced
guarantee, not just a code convention.

## Decision loop (one trading cycle)

```mermaid
sequenceDiagram
    participant Sched as Scheduler<br/>(Railway Cron)
    participant CP as control-plane
    participant LLM as Anthropic API
    participant DB as Supabase
    participant EXE as execution
    participant Broker as Alpaca

    Sched->>CP: fire (UTC, checks America/New_York window)
    CP->>DB: read latest market_snapshots row
    alt snapshot stale or missing
        CP->>DB: journal nav_unavailable / stale, emit zero intents
    else snapshot fresh
        CP->>LLM: specialist agent call (structured output)
        LLM-->>CP: StockRecommendation (or abstain: true)
        CP->>CP: range-validate (conviction, horizon bounds)
        alt schema/range invalid
            CP->>DB: journal schema_failure, stop
        else valid
            CP->>LLM: Allocator proposes
            par parallel critique
                CP->>LLM: Risk Officer checks vs hard limits
                CP->>LLM: Adversary attacks the proposal
            end
            CP->>LLM: Allocator — one revision only
            CP->>CP: codeVetoGate() — pure function, no LLM
            alt vetoed
                CP->>DB: journal vetoed, stop
            else approved
                CP->>CP: sizePosition() — quarter-Kelly (core) or flat-capped (asymmetric)
                CP->>CP: riskGate() — position/sleeve caps, daily-loss halt, buying power
                alt gate rejects
                    CP->>DB: journal gate_result.allow=false, reason
                else gate allows
                    CP->>DB: write decisions row + trade_intents (status=pending)
                end
            end
        end
    end

    loop poll every ~2s
        EXE->>DB: SELECT trade_intents FOR UPDATE SKIP LOCKED
    end
    EXE->>DB: reconcile check — refuse if not yet clean
    EXE->>Broker: POST /v2/orders (order_class=bracket, take_profit+stop_loss)
    Broker-->>EXE: order ack (client_order_id)
    EXE->>DB: write orders row
    Broker-->>EXE: fill event (WS, binary frames)
    EXE->>DB: write fills row, update positions_snapshot/nav_history
```

Every branch that stops short of a filled order still writes to the journal —
"no trade this cycle" is a logged, expected outcome, not a silent no-op.

## LLM observability: token and prompt tracking

Decision: capture full token usage and the exact rendered prompt for every
LLM call from the first call `control-plane` ever makes, not added later —
this is one-way. You cannot retroactively recover token counts or prompt
content for a call that already happened; a gap in this data is permanent.
The LLM spend cap (Ship Order M5) already requires per-run token accounting
to enforce its ceiling, so this formalizes that as durable, queryable data
instead of an ephemeral in-memory counter — the same numbers, kept.

**`agent_runs` gains columns beyond the original design** (role, model,
input_hash, raw_output, parsed_output, schema_valid, latency_ms):

```sql
ALTER TABLE agent_runs ADD COLUMN prompt_version_hash TEXT NOT NULL;
ALTER TABLE agent_runs ADD COLUMN messages JSONB NOT NULL;          -- the exact rendered message array sent
ALTER TABLE agent_runs ADD COLUMN effort TEXT;                       -- reasoning effort level used
ALTER TABLE agent_runs ADD COLUMN stop_reason TEXT;
ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER NOT NULL;
ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER NOT NULL;
ALTER TABLE agent_runs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cost_usd NUMERIC(10,6) NOT NULL;   -- computed at call time from a pricing
                                                                       -- table, not recomputed later — Anthropic
                                                                       -- pricing changes, historical cost shouldn't
```

**A new `prompt_versions` table dedupes system prompts** — they're mostly
static per role, changing only when the code changes, so storing the full
text on every row would be redundant. `prompt_version_hash` above is a
foreign key into this:

```sql
CREATE TABLE prompt_versions (
  hash          TEXT PRIMARY KEY,      -- sha256 of the system prompt text
  role          TEXT NOT NULL,         -- 'specialist' | 'allocator' | 'risk_officer' | 'adversary'
  system_prompt TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This means "did we change this prompt, and did it help" is a join away —
a new hash appearing in `prompt_versions` marks exactly when a prompt
changed, and every `agent_runs` row still points at the literal system
prompt (via the hash) and the exact filled-in message array it received.

**An aggregation view answers "do we need to optimize the prompts"
directly**, without ad-hoc querying every time:

```sql
CREATE VIEW llm_cost_by_role_day AS
SELECT role,
       date_trunc('day', created_at) AS day,
       model,
       count(*)                        AS calls,
       sum(input_tokens)               AS total_input_tokens,
       sum(output_tokens)              AS total_output_tokens,
       sum(cache_read_input_tokens)    AS total_cache_read_tokens,
       round(avg(cache_read_input_tokens::numeric /
             nullif(input_tokens, 0)), 3) AS avg_cache_hit_ratio,
       sum(cost_usd)                   AS total_cost_usd,
       avg(latency_ms)                 AS avg_latency_ms
FROM agent_runs
GROUP BY role, day, model;
```

`avg_cache_hit_ratio` matters specifically because of the RAG-vs-caching
finding from the earlier review: a healthy `MacroContext`/system-prompt
cache hit rate is the thing that keeps council calls cheap (~0.1× on cached
reads). If that ratio drops over time — e.g. because a timestamp or other
volatile field crept in before the cache breakpoint — this view surfaces it
as a cost regression before it needs a support ticket to notice.

Not decided yet, deferred to when `services/control-plane` is actually
built (M5): whether to also emit these as metrics to an external sink
(matches Ship Order's "structured logging + alerting" story) or whether the
Postgres view is sufficient at MVP call volume. Given one equities sleeve at
one cycle/day, it's sufficient — revisit if/when call volume from Tier 1
(crypto + prediction sleeves) makes the view too coarse.

## What's live vs. planned

| Layer | Status |
|---|---|
| Contracts (`packages/contracts`) | Built — all 5 schemas, range validation verified |
| DB schema, roles, RLS-equivalent grants | Designed (Ship Order §1), not yet migrated — needs a Supabase project |
| LLM token/prompt observability (`agent_runs` extension, `prompt_versions`, cost view) | Designed (this doc), not yet migrated — same blocker |
| Service scaffolds + credential guards | Built and verified (`services/*`) |
| Specialist agent, council, sizer, risk gate | Not yet implemented (M3/M5) |
| Stock sleeve (Alpaca) | Tier 0 — in progress |
| Crypto sleeve, Kalshi prediction sleeve, Polymarket reference feed | Tier 1 — not started |
| Macro data pipeline (GDELT, Federal Register, FRED, NWS/NHC) | Tier 2 — not started |
| Adaptive strategy loop, post-mortem classification, Strategy Observatory UI | Tier 2/3 — not started |
| Full circuit-breaker suite (L1–L6), flatten-all kill switch | Tier 3 — not started; MVP carries a minimal deadman switch + spend cap only |
