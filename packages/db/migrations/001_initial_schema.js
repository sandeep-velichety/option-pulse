/**
 * Migration 001 — full initial schema.
 *
 * All tables, indexes, views, DB roles, and grants ship in one migration
 * because several design decisions create dependencies that can't be
 * backfilled after the fact:
 *   - `agent_runs` token/cost columns: LLM call data can't be recovered
 *     retroactively for calls that happened before the columns existed.
 *   - `fills` append-only enforcement: REVOKE must be applied before the
 *     first fill is ever written, not after.
 *   - `agent_runs → decisions` deferrable FK: the deferred constraint must
 *     exist from the start so control-plane's write transaction works.
 *
 * See packages/db/README.md and docs/ARCHITECTURE.md for full rationale.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    -- ================================================================
    -- Prompt version deduplication
    -- ================================================================
    CREATE TABLE prompt_versions (
      hash          TEXT        PRIMARY KEY,
      role          TEXT        NOT NULL CHECK (role IN (
                      'specialist_stock', 'specialist_crypto',
                      'specialist_prediction', 'allocator',
                      'risk_officer', 'adversary'
                    )),
      system_prompt TEXT        NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ================================================================
    -- Strategy registry (active strategies + tombstone graveyard)
    -- ================================================================
    CREATE TABLE strategies (
      strategy_id      TEXT          PRIMARY KEY,
      sleeve_id        TEXT          NOT NULL,
      asset_class      TEXT          NOT NULL CHECK (asset_class IN ('stock', 'crypto', 'prediction')),
      version          INTEGER       NOT NULL DEFAULT 1,
      status           TEXT          NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'retiring', 'tombstoned')),
      policy           JSONB         NOT NULL DEFAULT '{}',
      capital_usd      NUMERIC(18,2) NOT NULL DEFAULT 0,
      peak_capital_usd NUMERIC(18,2) NOT NULL DEFAULT 0,
      lifetime_pnl_usd NUMERIC(18,2) NOT NULL DEFAULT 0,
      trade_count      INTEGER       NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
      retired_at       TIMESTAMPTZ,
      tombstone_reason TEXT,
      cooldown_until   TIMESTAMPTZ
    );

    -- ================================================================
    -- Market snapshots (written by execution, read by control-plane)
    -- ================================================================
    CREATE TABLE market_snapshots (
      snapshot_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      as_of       TIMESTAMPTZ NOT NULL,
      session     TEXT        NOT NULL CHECK (session IN ('pre', 'open', 'post', 'closed')),
      input_hash  TEXT        NOT NULL,
      snapshot    JSONB       NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX market_snapshots_as_of ON market_snapshots (as_of DESC);

    -- ================================================================
    -- Portfolio tracking
    -- ================================================================
    CREATE TABLE nav_history (
      id                BIGSERIAL     PRIMARY KEY,
      as_of             TIMESTAMPTZ   NOT NULL,
      nav_usd           NUMERIC(18,2) NOT NULL,
      peak_nav_usd      NUMERIC(18,2) NOT NULL,
      drawdown_fraction NUMERIC(8,6)  NOT NULL,
      daily_pnl_usd     NUMERIC(18,2) NOT NULL,
      halt_level        INTEGER       NOT NULL DEFAULT 0,
      source            TEXT          NOT NULL CHECK (source IN ('fill', 'eod_reconcile', 'manual')),
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
    CREATE INDEX nav_history_as_of ON nav_history (as_of DESC);

    CREATE TABLE positions_snapshot (
      id                      BIGSERIAL     PRIMARY KEY,
      as_of                   TIMESTAMPTZ   NOT NULL,
      positions               JSONB         NOT NULL,
      total_market_value_usd  NUMERIC(18,2) NOT NULL,
      asymmetric_notional_usd NUMERIC(18,2) NOT NULL DEFAULT 0,
      source                  TEXT          NOT NULL CHECK (source IN ('fill', 'eod_reconcile')),
      created_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
    CREATE INDEX positions_snapshot_as_of ON positions_snapshot (as_of DESC);

    -- ================================================================
    -- Decision journal
    -- Append-only: UPDATE/DELETE revoked from all roles below.
    -- Written once per cycle as a complete, final row by control-plane.
    -- ================================================================
    CREATE TABLE decisions (
      decision_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id    TEXT        NOT NULL REFERENCES strategies(strategy_id),
      snapshot_id    UUID        NOT NULL REFERENCES market_snapshots(snapshot_id),
      ticker         TEXT        NOT NULL,
      verdict        TEXT        NOT NULL CHECK (verdict IN (
                       'approve', 'reject', 'abstain',
                       'gate_rejected', 'schema_failure',
                       'no_snapshot', 'stale_snapshot'
                     )),
      verdict_reason TEXT,
      gate_result    JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX decisions_created ON decisions (created_at DESC);
    CREATE INDEX decisions_ticker  ON decisions (ticker, created_at DESC);

    -- ================================================================
    -- LLM call audit log
    --
    -- agent_runs → decisions FK is DEFERRABLE so control-plane can
    -- INSERT agent_runs rows (with the future decision_id) within one
    -- transaction and INSERT the decisions row at COMMIT time.
    -- ================================================================
    CREATE TABLE agent_runs (
      run_id                    UUID          PRIMARY KEY,
      decision_id               UUID          NOT NULL,
      role                      TEXT          NOT NULL,
      agent_version             TEXT          NOT NULL,
      model                     TEXT          NOT NULL,
      input_hash                TEXT          NOT NULL,
      prompt_version_hash       TEXT          NOT NULL REFERENCES prompt_versions(hash),
      messages                  JSONB         NOT NULL,
      effort                    TEXT,
      raw_output                TEXT          NOT NULL,
      parsed_output             JSONB,
      schema_valid              BOOLEAN       NOT NULL,
      stop_reason               TEXT,
      input_tokens              INTEGER       NOT NULL,
      output_tokens             INTEGER       NOT NULL,
      cache_read_input_tokens   INTEGER       NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER     NOT NULL DEFAULT 0,
      cost_usd                  NUMERIC(10,6) NOT NULL,
      latency_ms                INTEGER       NOT NULL,
      created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT fk_agent_runs_decision
        FOREIGN KEY (decision_id)
        REFERENCES decisions(decision_id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX agent_runs_decision ON agent_runs (decision_id);
    CREATE INDEX agent_runs_created  ON agent_runs (created_at DESC);

    -- ================================================================
    -- Trade intent queue (inter-process communication channel)
    -- Written by control-plane; claimed and submitted by execution.
    -- ================================================================
    CREATE TABLE trade_intents (
      intent_id       UUID          PRIMARY KEY,
      run_id          UUID          NOT NULL,
      decision_id     UUID          NOT NULL REFERENCES decisions(decision_id),
      client_order_id TEXT          NOT NULL UNIQUE,
      ticker          TEXT          NOT NULL,
      side            TEXT          NOT NULL CHECK (side IN ('buy', 'sell')),
      qty             NUMERIC(18,8) NOT NULL CHECK (qty > 0),
      notional_usd    NUMERIC(18,2) NOT NULL CHECK (notional_usd > 0),
      order_type      TEXT          NOT NULL CHECK (order_type IN ('market', 'limit')),
      limit_price     NUMERIC(18,4),
      time_in_force   TEXT          NOT NULL DEFAULT 'day' CHECK (time_in_force = 'day'),
      bracket         JSONB         NOT NULL,
      bet_class       TEXT          NOT NULL CHECK (bet_class IN ('core', 'asymmetric')),
      sleeve_id       TEXT          NOT NULL,
      strategy_id     TEXT          NOT NULL REFERENCES strategies(strategy_id),
      sizing          JSONB         NOT NULL,
      expires_at      TIMESTAMPTZ   NOT NULL,
      status          TEXT          NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'claimed', 'rejected', 'submitted', 'failed')),
      schema_version  INTEGER       NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
    CREATE INDEX trade_intents_pending
      ON trade_intents (created_at)
      WHERE status = 'pending';

    -- ================================================================
    -- Orders and fills (Alpaca execution records)
    -- ================================================================
    CREATE TABLE orders (
      order_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      intent_id       UUID          NOT NULL REFERENCES trade_intents(intent_id),
      client_order_id TEXT          NOT NULL REFERENCES trade_intents(client_order_id),
      alpaca_order_id TEXT          NOT NULL UNIQUE,
      ticker          TEXT          NOT NULL,
      side            TEXT          NOT NULL CHECK (side IN ('buy', 'sell')),
      qty             NUMERIC(18,8) NOT NULL,
      order_type      TEXT          NOT NULL,
      alpaca_status   TEXT          NOT NULL,
      submitted_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
      raw_response    JSONB         NOT NULL,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
    CREATE INDEX orders_intent ON orders (intent_id);

    -- Append-only: fills are the primary audit trail of real money movement.
    -- UPDATE/DELETE revoked from all roles below.
    CREATE TABLE fills (
      fill_id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id        UUID          NOT NULL REFERENCES orders(order_id),
      alpaca_order_id TEXT          NOT NULL,
      ticker          TEXT          NOT NULL,
      side            TEXT          NOT NULL CHECK (side IN ('buy', 'sell')),
      qty             NUMERIC(18,8) NOT NULL,
      fill_price      NUMERIC(18,4) NOT NULL,
      filled_at       TIMESTAMPTZ   NOT NULL,
      raw_event       JSONB         NOT NULL,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
    CREATE INDEX fills_order     ON fills (order_id);
    CREATE INDEX fills_filled_at ON fills (filled_at DESC);

    -- ================================================================
    -- LLM cost aggregation view
    -- avg_cache_hit_ratio: early warning if MacroContext caching regresses
    -- ================================================================
    CREATE VIEW llm_cost_by_role_day AS
    SELECT
      role,
      date_trunc('day', created_at)                                     AS day,
      model,
      count(*)                                                          AS calls,
      sum(input_tokens)                                                 AS total_input_tokens,
      sum(output_tokens)                                                AS total_output_tokens,
      sum(cache_read_input_tokens)                                      AS total_cache_read_tokens,
      round(
        avg(cache_read_input_tokens::numeric / nullif(input_tokens, 0)),
        3
      )                                                                 AS avg_cache_hit_ratio,
      sum(cost_usd)                                                     AS total_cost_usd,
      avg(latency_ms)                                                   AS avg_latency_ms
    FROM agent_runs
    GROUP BY role, date_trunc('day', created_at), model;

    -- ================================================================
    -- DB roles (idempotent CREATE)
    -- ================================================================
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cp_role'
      ) THEN CREATE ROLE cp_role NOLOGIN; END IF;

      IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'exec_role'
      ) THEN CREATE ROLE exec_role NOLOGIN; END IF;

      IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ops_role'
      ) THEN CREATE ROLE ops_role NOLOGIN; END IF;
    END $$;

    -- ================================================================
    -- Grants
    -- ================================================================

    -- cp_role: write audit trail + read market/portfolio state
    GRANT INSERT, SELECT ON prompt_versions     TO cp_role;
    GRANT INSERT, SELECT ON agent_runs          TO cp_role;
    GRANT INSERT, SELECT ON decisions           TO cp_role;
    GRANT INSERT, SELECT ON trade_intents       TO cp_role;
    GRANT SELECT          ON market_snapshots   TO cp_role;
    GRANT SELECT          ON nav_history        TO cp_role;
    GRANT SELECT          ON positions_snapshot TO cp_role;
    GRANT SELECT          ON strategies         TO cp_role;
    GRANT SELECT          ON llm_cost_by_role_day TO cp_role;

    -- exec_role: claim queue + write market/portfolio state
    GRANT SELECT, UPDATE  ON trade_intents      TO exec_role;
    GRANT INSERT, SELECT  ON orders             TO exec_role;
    GRANT INSERT, SELECT  ON fills              TO exec_role;
    GRANT INSERT, SELECT  ON market_snapshots   TO exec_role;
    GRANT INSERT, SELECT  ON nav_history        TO exec_role;
    GRANT INSERT, SELECT  ON positions_snapshot TO exec_role;
    GRANT SELECT, UPDATE  ON strategies         TO exec_role;

    -- ops_role: read-only across all tables
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ops_role;

    -- Sequence usage (needed for BIGSERIAL columns in INSERT)
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO exec_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cp_role;

    -- ================================================================
    -- Append-only enforcement: strip UPDATE/DELETE from decisions + fills
    -- ================================================================
    REVOKE UPDATE, DELETE ON decisions FROM cp_role;
    REVOKE UPDATE, DELETE ON decisions FROM exec_role;
    REVOKE UPDATE, DELETE ON decisions FROM ops_role;
    REVOKE UPDATE, DELETE ON fills     FROM cp_role;
    REVOKE UPDATE, DELETE ON fills     FROM exec_role;
    REVOKE UPDATE, DELETE ON fills     FROM ops_role;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    DROP VIEW  IF EXISTS llm_cost_by_role_day  CASCADE;
    DROP TABLE IF EXISTS fills                 CASCADE;
    DROP TABLE IF EXISTS orders                CASCADE;
    DROP TABLE IF EXISTS trade_intents         CASCADE;
    DROP TABLE IF EXISTS agent_runs            CASCADE;
    DROP TABLE IF EXISTS decisions             CASCADE;
    DROP TABLE IF EXISTS positions_snapshot    CASCADE;
    DROP TABLE IF EXISTS nav_history           CASCADE;
    DROP TABLE IF EXISTS market_snapshots      CASCADE;
    DROP TABLE IF EXISTS strategies            CASCADE;
    DROP TABLE IF EXISTS prompt_versions       CASCADE;
    -- NOTE: DB roles (cp_role, exec_role, ops_role) must be dropped manually
    -- after revoking all privileges — they may own objects in other schemas.
  `);
};
