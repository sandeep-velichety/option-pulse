-- Migration 002 (post_mortems) as plain SQL, for the Supabase SQL editor.
-- Safe to run more than once. Run as the postgres super-user (it creates a table and grants).
--
-- Why this exists: this database was provisioned without node-pg-migrate's `pgmigrations`
-- bookkeeping table, so `npm run migrate` would try to re-run 001 against existing tables and
-- fail. Use this file for 002 instead.

CREATE TABLE IF NOT EXISTS post_mortems (
  pm_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id        UUID        NOT NULL REFERENCES trade_intents(intent_id),
  ticker           TEXT        NOT NULL,
  side             TEXT        NOT NULL CHECK (side IN ('buy', 'sell')),
  entry_price      NUMERIC(18,4) NOT NULL,
  exit_price       NUMERIC(18,4) NOT NULL,
  realized_pnl_usd NUMERIC(18,2) NOT NULL,
  classification   TEXT        NOT NULL CHECK (classification IN (
                     'thesis_right', 'thesis_wrong', 'execution_bug',
                     'lucky_win', 'resolution_mismatch')),
  exit_reason      TEXT        NOT NULL CHECK (exit_reason IN (
                     'take_profit', 'stop_loss', 'expired', 'manual')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_mortems_ticker ON post_mortems (ticker, created_at DESC);

GRANT INSERT, SELECT ON post_mortems TO exec_role;
GRANT SELECT         ON post_mortems TO cp_role;
GRANT SELECT         ON post_mortems TO ops_role;

-- Verify: all three should be true.
SELECT has_table_privilege('exec_role', 'public.post_mortems', 'INSERT') AS exec_can_insert,
       has_table_privilege('cp_role',   'public.post_mortems', 'SELECT') AS cp_can_read,
       has_table_privilege('ops_role',  'public.post_mortems', 'SELECT') AS ops_can_read;
