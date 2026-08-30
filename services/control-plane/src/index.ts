// control-plane: scheduler, market-snapshot reader, specialist agent,
// council, sizer, journal writer.
//
// Invariant (Ship Order §2): this process holds ANTHROPIC_API_KEY and
// cp_role DB credentials only. It must never read ALPACA_KEY/ALPACA_SECRET
// and must never accept inbound traffic from the public internet. It talks
// to execution-service only through the database (market_snapshots read,
// trade_intents write) — never HTTP.

if (process.env.ALPACA_KEY || process.env.ALPACA_SECRET) {
  throw new Error(
    "control-plane must never hold Alpaca credentials — credential isolation violated",
  );
}

console.log("[control-plane] boot stub — scheduler/specialist/council not yet implemented (Ship Order M2/M5)");
