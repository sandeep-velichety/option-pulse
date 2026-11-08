/**
 * Migration 002 — post_mortems table.
 *
 * Stores per-trade outcome analysis after a position is closed.
 * Linked to trade_intents so every closed intent can have exactly one
 * post-mortem row written by the execution service.
 *
 * Roles:
 *   exec_role — INSERT + SELECT (execution writes rows when fills close)
 *   cp_role   — SELECT only (control-plane reads for cycle feedback)
 *   ops_role  — SELECT only (read-only monitoring)
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE post_mortems (
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
    CREATE INDEX post_mortems_ticker ON post_mortems (ticker, created_at DESC);
    GRANT INSERT, SELECT ON post_mortems TO exec_role;
    GRANT SELECT         ON post_mortems TO cp_role;
    GRANT SELECT         ON post_mortems TO ops_role;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS post_mortems CASCADE;
  `);
};
