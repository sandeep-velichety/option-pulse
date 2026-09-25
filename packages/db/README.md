# @trading-council/db

Migrations for the Supabase (Postgres) schema, via `node-pg-migrate`.

**Not wired yet** — migration 001 needs a live Supabase project connection
string before it can be run. See Ship Order §1 and §4 (Milestone 1) for the
schema and the reasoning behind the role split (`cp_role` / `exec_role` /
`ops_role`).

Once a Supabase project exists, add `DATABASE_URL` (Supavisor **session mode**,
port 5432) to `.env` and run:

```
npm run migrate --workspace @trading-council/db
```

## Migration 001 checklist — everything that must land together

The schema is one migration, not many, because several design decisions create
dependencies that can't be backfilled:

- [ ] **Core tables**: `decisions`, `agent_runs`, `market_snapshots`,
      `trade_intents`, `orders`, `fills`, `positions_snapshot`, `nav_history`,
      `strategies`
- [ ] **`trade_intents`** — the full inter-process communication contract.
      Schema is the `TradeIntent` Zod type in `packages/contracts/src/trade-intent.ts`,
      including the `sizing` JSONB column (`nav_at_decision`, `edge`, `variance`,
      `kelly_f_raw`, `kelly_f_capped`, `cap_applied`). The `kellySizer()` output
      maps directly onto this column.
- [ ] **`agent_runs` extended columns** — `prompt_version_hash`, `messages` (JSONB),
      `effort`, `stop_reason`, `input_tokens`, `output_tokens`,
      `cache_read_input_tokens`, `cache_creation_input_tokens`, `cost_usd`.
      These CANNOT be added later — token/prompt history for calls that
      already happened cannot be recovered. Ships in 001 or never.
      Full column definitions: `docs/ARCHITECTURE.md` §"LLM observability".
- [ ] **`prompt_versions` table** — dedupes system prompts, stores `hash`,
      `role`, `system_prompt`, `first_seen_at`. `agent_runs.prompt_version_hash`
      is a FK into this table.
- [ ] **`llm_cost_by_role_day` view** — aggregation over `agent_runs` for
      cost/cache-hit monitoring. Definition in `docs/ARCHITECTURE.md`.
- [ ] **DB roles and grants**: create `cp_role`, `exec_role`, `ops_role` with
      only the grants in `docs/ARCHITECTURE.md` §"Credential / DB-role matrix".
- [ ] **`REVOKE UPDATE, DELETE`** on `decisions` and `fills` from all three roles
      — this makes the append-only audit guarantee a database-level invariant,
      not just a code convention.
- [ ] **`gate_results` JSONB column on `decisions`** — stores the full
      `GateResult` output (all nine check names + pass/fail) from `riskGate()`
      in `packages/sizer`. Every cycle that reached the gate must record its
      complete check results, not just whether it was allowed. This enables
      post-mortem debugging of false-negative gates.

## What the sizer needs at runtime

`packages/sizer` (`kellySizer` + `riskGate`) is fully implemented and tested.
At runtime `control-plane` will need to query two values from the DB before
calling the sizer:

1. **Current NAV** — latest row from `nav_history` (written by `execution`
   after every fill and at end-of-day reconciliation).
2. **Asymmetric notional open** — `SUM(notional_usd)` from `trade_intents`
   WHERE `bet_class = 'asymmetric'` AND `status IN ('pending', 'claimed')`.

Both are `exec_role` writes / `cp_role` reads — already covered by the role
matrix. No new tables needed; this is a query, not a schema change.
