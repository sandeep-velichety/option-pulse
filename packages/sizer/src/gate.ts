import { GateResult } from "@trading-council/contracts";
import type { TradeIntent, MarketSnapshot } from "@trading-council/contracts";
import { DEFAULT_GATE_CONFIG } from "./types.js";
import type { PortfolioState, GateConfig } from "./types.js";

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

/**
 * Pure function. Runs every risk check against a fully-assembled TradeIntent
 * and returns ALL results — not just the first failure — so the decision
 * journal has a complete picture.
 *
 * Returns allow=false if any check fails; the gate never throws.
 */
export function riskGate(
  intent: TradeIntent,
  snapshot: MarketSnapshot,
  portfolio: PortfolioState,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateResult {
  const checks: Check[] = [];

  // 1. Market must be open for new entries
  checks.push({
    name: "market_open",
    pass: snapshot.session === "open",
    detail: `session=${snapshot.session}`,
  });

  // 2. Symbol must exist, be tradable, and not halted
  const sym = snapshot.symbols[intent.ticker];
  if (sym === undefined) {
    checks.push({
      name: "symbol_tradable",
      pass: false,
      detail: `${intent.ticker} missing from snapshot`,
    });
  } else {
    checks.push({
      name: "symbol_tradable",
      pass: sym.tradable && !sym.halted,
      detail: `tradable=${sym.tradable} halted=${sym.halted}`,
    });
  }

  // 3. Circuit breaker — L2+ halts block all new entries
  checks.push({
    name: "circuit_breaker_clear",
    pass: portfolio.haltLevel < config.blockOnHaltLevel,
    detail: `halt_level=${portfolio.haltLevel} blocks_at=${config.blockOnHaltLevel}`,
  });

  // 4. Daily loss limit
  const dailyLossFloor =
    -Math.abs(config.dailyLossLimitFraction * portfolio.currentNav);
  checks.push({
    name: "daily_loss_limit",
    pass: portfolio.dailyPnlUsd >= dailyLossFloor,
    detail: `daily_pnl=${portfolio.dailyPnlUsd.toFixed(2)} floor=${dailyLossFloor.toFixed(2)}`,
  });

  // 5. Portfolio drawdown limit
  const drawdown =
    portfolio.peakNav > 0
      ? 1 - portfolio.currentNav / portfolio.peakNav
      : 0;
  checks.push({
    name: "portfolio_drawdown",
    pass: drawdown < config.maxDrawdownFraction,
    detail: `drawdown=${(drawdown * 100).toFixed(2)}% limit=${(config.maxDrawdownFraction * 100).toFixed(2)}%`,
  });

  // 6. No duplicate pending intent for the same ticker
  checks.push({
    name: "no_duplicate_intent",
    pass: !portfolio.openIntentTickers.includes(intent.ticker),
    detail: `ticker=${intent.ticker}`,
  });

  // 7. Notional must be positive — catches floored sizer output
  checks.push({
    name: "notional_positive",
    pass: intent.notional_usd > 0,
    detail: `notional_usd=${intent.notional_usd}`,
  });

  // 8. Hard NAV cap — no single position may exceed 5% NAV
  const hardCap = 0.05 * intent.sizing.nav_at_decision;
  checks.push({
    name: "notional_hard_cap",
    pass: intent.notional_usd <= hardCap + 0.01, // 1¢ float tolerance
    detail: `notional=${intent.notional_usd.toFixed(2)} hard_cap=${hardCap.toFixed(2)}`,
  });

  // 9. Asymmetric aggregate limit (only for asymmetric positions)
  if (intent.bet_class === "asymmetric") {
    const projected =
      portfolio.asymmetricNotionalOpen + intent.notional_usd;
    const aggregateCap = 0.05 * intent.sizing.nav_at_decision;
    checks.push({
      name: "asym_aggregate_ok",
      pass: projected <= aggregateCap + 0.01,
      detail: `projected=${projected.toFixed(2)} cap=${aggregateCap.toFixed(2)}`,
    });
  }

  const failed = checks.filter((c) => !c.pass);
  const allow = failed.length === 0;

  return GateResult.parse({
    allow,
    reason: failed.length > 0 ? failed.map((c) => c.name).join(", ") : null,
    checks,
  });
}
