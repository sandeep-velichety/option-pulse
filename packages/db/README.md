# @trading-council/db

Migrations for the Supabase (Postgres) schema, via `node-pg-migrate`.

**Not wired yet** — the first migration (tables, `trade_intents`, `market_snapshots`,
per-role grants, and the `REVOKE UPDATE, DELETE` on `decisions`/`fills`) needs a
live Supabase project connection string before it can be written and run. See
Ship Order §1 and §4 (Milestone 1) for the schema and the reasoning behind the
role split (`cp_role` / `exec_role` / `ops_role`).

Once a Supabase project exists, add `DATABASE_URL` (Supavisor **session mode**,
port 5432) to `.env` and run:

```
npm run migrate --workspace @trading-council/db
```
