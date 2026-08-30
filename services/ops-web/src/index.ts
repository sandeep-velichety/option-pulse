// ops-web: read-only visibility layer (Ship Order §1.4, §2).
//
// Invariant: this process holds ops_role DB credentials (SELECT only) and
// nothing else — no Alpaca keys, no Anthropic key, no write path back into
// the trading system. It serves public/ops.html plus 3 read-only JSON
// endpoints: /api/ops/status, /api/ops/decisions, /api/ops/positions.
//
// Deliberately NOT using Supabase's auto-generated Data API for this — see
// Ship Order §1.4 for why (RLS is default-off on new tables; a public DB
// API is the same failure mode this whole pivot exists to fix).

if (process.env.ANTHROPIC_API_KEY || process.env.ALPACA_KEY || process.env.ALPACA_SECRET) {
  throw new Error(
    "ops-web must hold no Alpaca or Anthropic credentials — credential isolation violated",
  );
}

console.log("[ops-web] boot stub — status/decisions/positions endpoints not yet implemented (Ship Order M6)");
