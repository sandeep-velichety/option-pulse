// execution-service: rate-limited Alpaca client, risk gate, trade_intents
// poller, order submission, reconciliation, NAV tracker, market_snapshots
// writer.
//
// Invariant (Ship Order §2): this process holds ALPACA_KEY/ALPACA_SECRET
// and exec_role DB credentials only. It must have no LLM/Anthropic
// dependency of any kind, and must never accept inbound traffic from the
// public internet. This is enforced here at runtime and should also be
// enforced in CI (Ship Order M1: credential-boundary guard).

if (process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "execution-service must never hold an LLM credential — credential isolation violated",
  );
}

console.log("[execution] boot stub — Alpaca client/gate/reconciliation not yet implemented (Ship Order M3/M4)");
