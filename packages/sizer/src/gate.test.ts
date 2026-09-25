import { describe, it, expect } from "vitest";
import { riskGate } from "./gate.js";
import type { TradeIntent, MarketSnapshot } from "@trading-council/contracts";
import type { PortfolioState } from "./types.js";

// Minimal valid TradeIntent for tests
const INTENT: TradeIntent = {
  schema_version: 1,
  intent_id: "00000000-0000-0000-0000-000000000001",
  run_id: "00000000-0000-0000-0000-000000000002",
  decision_id: "d001",
  client_order_id: "abcd1234abcd1234abcd1234abcd1234",
  ticker: "AAPL",
  side: "buy",
  qty: 5,
  notional_usd: 1_000,
  order_type: "market",
  limit_price: null,
  time_in_force: "day",
  bracket: { take_profit_price: 210, stop_loss_price: 185 },
  bet_class: "core",
  sleeve_id: "stocks-core",
  strategy_id: "momentum-v1",
  sizing: {
    nav_at_decision: 100_000,
    edge: 0.003,
    variance: 0.0015,
    kelly_f_raw: 2.0,
    kelly_f_capped: 0.01,
    cap_applied: "kelly_cap",
  },
  expires_at: "2099-01-01T00:00:00.000Z",
  status: "pending",
};

// Minimal MarketSnapshot
const SNAPSHOT: MarketSnapshot = {
  schema_version: 1,
  as_of: "2026-09-24T14:30:00.000Z",
  session: "open",
  regime: {
    vix: 18,
    vix_source: "FRED:VIXCLS",
    vix_as_of: "2026-09-24T00:00:00.000Z",
    vix_stale_days: 0,
  },
  symbols: {
    AAPL: {
      last: 200,
      prev_close: 198,
      bars_1d: [],
      ma20: 195,
      ma50: 190,
      ma200: 180,
      atr_14: 3.5,
      realized_vol_20d: 0.18,
      iv_rank: 35,
      volume_z_20d: 0.5,
      adv_20d: 80_000_000,
      tradable: true,
      shortable: true,
      halted: false,
    },
  },
  data_quality: { feed: "sip", missing: [], stale: [] },
};

const PORTFOLIO: PortfolioState = {
  haltLevel: 0,
  currentNav: 100_000,
  peakNav: 100_000,
  dailyPnlUsd: 0,
  asymmetricNotionalOpen: 0,
  openIntentTickers: [],
};

describe("riskGate — all checks pass", () => {
  it("returns allow=true when every check passes", () => {
    const result = riskGate(INTENT, SNAPSHOT, PORTFOLIO);
    expect(result.allow).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });
});

describe("riskGate — individual check failures", () => {
  it("fails market_open when session is closed", () => {
    const snap: MarketSnapshot = { ...SNAPSHOT, session: "closed" };
    const result = riskGate(INTENT, snap, PORTFOLIO);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "market_open")?.pass).toBe(false);
    expect(result.reason).toContain("market_open");
  });

  it("fails symbol_tradable when symbol is halted", () => {
    const snap: MarketSnapshot = {
      ...SNAPSHOT,
      symbols: {
        AAPL: { ...SNAPSHOT.symbols["AAPL"]!, halted: true },
      },
    };
    const result = riskGate(INTENT, snap, PORTFOLIO);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "symbol_tradable")?.pass).toBe(false);
  });

  it("fails symbol_tradable when symbol missing from snapshot", () => {
    const snap: MarketSnapshot = { ...SNAPSHOT, symbols: {} };
    const result = riskGate(INTENT, snap, PORTFOLIO);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "symbol_tradable")?.pass).toBe(false);
  });

  it("fails circuit_breaker_clear at halt level 2", () => {
    const portfolio: PortfolioState = { ...PORTFOLIO, haltLevel: 2 };
    const result = riskGate(INTENT, SNAPSHOT, portfolio);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "circuit_breaker_clear")?.pass).toBe(false);
  });

  it("passes circuit_breaker_clear at halt level 1 (advisory only)", () => {
    const portfolio: PortfolioState = { ...PORTFOLIO, haltLevel: 1 };
    const result = riskGate(INTENT, SNAPSHOT, portfolio);
    expect(result.checks.find((c) => c.name === "circuit_breaker_clear")?.pass).toBe(true);
  });

  it("fails daily_loss_limit when loss exceeds 2% NAV", () => {
    const portfolio: PortfolioState = { ...PORTFOLIO, dailyPnlUsd: -2_100 };
    const result = riskGate(INTENT, SNAPSHOT, portfolio);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "daily_loss_limit")?.pass).toBe(false);
  });

  it("passes daily_loss_limit at exactly the 2% floor", () => {
    const portfolio: PortfolioState = { ...PORTFOLIO, dailyPnlUsd: -2_000 };
    const result = riskGate(INTENT, SNAPSHOT, portfolio);
    expect(result.checks.find((c) => c.name === "daily_loss_limit")?.pass).toBe(true);
  });

  it("fails portfolio_drawdown at 10%+ drawdown", () => {
    const portfolio: PortfolioState = {
      ...PORTFOLIO,
      currentNav: 89_000,
      peakNav: 100_000,
    };
    const result = riskGate(INTENT, SNAPSHOT, portfolio);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "portfolio_drawdown")?.pass).toBe(false);
  });

  it("fails no_duplicate_intent when ticker already has open intent", () => {
    const portfolio: PortfolioState = {
      ...PORTFOLIO,
      openIntentTickers: ["AAPL"],
    };
    const result = riskGate(INTENT, SNAPSHOT, portfolio);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "no_duplicate_intent")?.pass).toBe(false);
  });

  it("fails notional_positive when sizer produced 0 (floored)", () => {
    const intent: TradeIntent = { ...INTENT, notional_usd: 0, qty: 0.001 };
    // Note: Zod requires qty > 0 and notional_usd > 0 in the final schema,
    // but the gate catches this before the intent is written to DB.
    // We pass a minimal non-zero qty to keep the Zod parse valid in the test.
    const result = riskGate({ ...INTENT, notional_usd: 0.001 }, SNAPSHOT, PORTFOLIO);
    // notional_usd=0.001 is technically > 0 but rounds to ~0 in practice;
    // test the boundary directly:
    const result2 = riskGate(
      { ...INTENT, notional_usd: 0, qty: 0.0001 } as TradeIntent,
      SNAPSHOT,
      PORTFOLIO,
    );
    expect(result2.checks.find((c) => c.name === "notional_positive")?.pass).toBe(false);
  });

  it("fails notional_hard_cap when notional exceeds 5% NAV", () => {
    const intent: TradeIntent = {
      ...INTENT,
      notional_usd: 5_100,
      sizing: { ...INTENT.sizing, kelly_f_capped: 0.051 },
    };
    const result = riskGate(intent, SNAPSHOT, PORTFOLIO);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "notional_hard_cap")?.pass).toBe(false);
  });
});

describe("riskGate — asymmetric aggregate check", () => {
  const ASYM_INTENT: TradeIntent = {
    ...INTENT,
    bet_class: "asymmetric",
    notional_usd: 1_000,
    sizing: { ...INTENT.sizing, kelly_f_capped: 0.01 },
  };

  it("checks asym_aggregate_ok for asymmetric positions", () => {
    const result = riskGate(ASYM_INTENT, SNAPSHOT, PORTFOLIO);
    expect(result.checks.find((c) => c.name === "asym_aggregate_ok")).toBeDefined();
  });

  it("fails asym_aggregate_ok when aggregate would exceed 5% NAV", () => {
    const portfolio: PortfolioState = {
      ...PORTFOLIO,
      asymmetricNotionalOpen: 4_500,
    };
    // projected = 4500 + 1000 = 5500 > 5000
    const result = riskGate(ASYM_INTENT, SNAPSHOT, portfolio);
    expect(result.allow).toBe(false);
    expect(result.checks.find((c) => c.name === "asym_aggregate_ok")?.pass).toBe(false);
  });

  it("does not add asym_aggregate_ok check for core positions", () => {
    const result = riskGate(INTENT, SNAPSHOT, PORTFOLIO); // INTENT is core
    expect(result.checks.find((c) => c.name === "asym_aggregate_ok")).toBeUndefined();
  });
});

describe("riskGate — multiple failures reported together", () => {
  it("reports all failures in reason string, not just the first", () => {
    const snap: MarketSnapshot = { ...SNAPSHOT, session: "closed" };
    const portfolio: PortfolioState = {
      ...PORTFOLIO,
      haltLevel: 3,
      dailyPnlUsd: -5_000,
    };
    const result = riskGate(INTENT, snap, portfolio);
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("market_open");
    expect(result.reason).toContain("circuit_breaker_clear");
    expect(result.reason).toContain("daily_loss_limit");
  });
});
