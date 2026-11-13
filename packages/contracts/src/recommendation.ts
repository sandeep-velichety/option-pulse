import { z } from "zod";

// Anthropic structured-output JSON Schema can't express numeric bounds
// (min/max) — the model is only told the shape. This Zod schema is the
// runtime validator that enforces the bounds afterward; a schema-valid
// but out-of-range recommendation (e.g. conviction: 1.7) must be rejected
// here and journaled as a schema failure, never coerced into range.

const Evidence = z.object({
  claim: z.string(),
  source: z.string(), // must reference a MarketSnapshot path, e.g. "symbols.AAPL.iv_rank"
  // `value` is documentation for the human reading the journal, not a decision input, so be
  // tolerant of whatever shape the model cites. An "absent" field (e.g. no macro data) arrives
  // as null; objects/arrays are common ({last, ma20, ma50}). Rejecting these made the model's
  // correct ABSTAIN fail validation, which crashed the cycle and left no decision row.
  value: z.preprocess((v) => {
    if (v === null || v === undefined) return 'unavailable';
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return String(v);
    return v;
  }, z.union([z.string(), z.number()])),
});

export const BetClass = z.enum(["core", "asymmetric"]);
export type BetClass = z.infer<typeof BetClass>;

export const StockRecommendation = z.object({
  schema_version: z.literal(1),
  run_id: z.string().uuid(),
  input_hash: z.string(),
  agent_version: z.string(),
  model: z.string(),

  // Legal "no trade" path — without this the schema forces a recommendation
  // to exist even when nothing clears the bar.
  abstain: z.boolean(),

  ticker: z.string(),
  direction: z.enum(["long", "short", "flat"]),
  conviction: z.number().min(0).max(1),
  thesis: z.string().min(1),
  horizon_days: z.number().int().min(1).max(90),
  invalidation_condition: z.string().min(1),
  evidence: z.array(Evidence).min(1),
  est_edge_bps: z.number(),
  est_vol: z.number().positive(),
  bet_class: BetClass,
});

export type StockRecommendation = z.infer<typeof StockRecommendation>;
