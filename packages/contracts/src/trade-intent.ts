import { z } from "zod";
import { BetClass } from "./recommendation.js";

// node-pg returns NUMERIC as string and TIMESTAMPTZ as Date — coerce both.
const num = z.preprocess(
  (v) => (typeof v === "string" ? parseFloat(v) : v),
  z.number(),
);
const numPos = z.preprocess(
  (v) => (typeof v === "string" ? parseFloat(v) : v),
  z.number().positive(),
);
const numPosNullable = z.preprocess(
  (v) => (typeof v === "string" ? parseFloat(v) : v),
  z.number().positive().nullable(),
);
const dateStr = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().datetime(),
);

export const TradeIntent = z.object({
  schema_version: z.literal(1),
  intent_id: z.string().uuid(),
  run_id: z.string().uuid(),
  decision_id: z.string(),

  // sha256(strategy_id|ticker|side|trade_date|decision_id).slice(0, 32) —
  // deterministic so a retried submission after a crash produces the same
  // id and the broker's own idempotency rejects the duplicate.
  client_order_id: z.string(),

  ticker: z.string(),
  side: z.enum(["buy", "sell"]),
  qty: numPos,
  notional_usd: numPos,
  order_type: z.enum(["market", "limit"]),
  limit_price: numPosNullable,
  time_in_force: z.literal("day"),

  bracket: z.object({
    take_profit_price: numPos,
    stop_loss_price: numPos,
  }),

  bet_class: BetClass,
  sleeve_id: z.string(),
  strategy_id: z.string(),

  sizing: z.object({
    nav_at_decision: num,
    edge: num,
    variance: num,
    kelly_f_raw: z.preprocess(
      (v) => (typeof v === "string" ? parseFloat(v) : v),
      z.number().nullable(),
    ),
    kelly_f_capped: z.preprocess(
      (v) => (typeof v === "string" ? parseFloat(v) : v),
      z.number().min(0).max(0.05),
    ),
    cap_applied: z.enum([
      "kelly_cap",
      "floor",
      "asym_flat_cap",
      "asym_aggregate_cap",
      "none",
    ]),
  }),

  // Stale intents are dropped, never executed.
  expires_at: dateStr,
  status: z.enum(["pending", "claimed", "rejected", "submitted", "failed"]),
});

export type TradeIntent = z.infer<typeof TradeIntent>;
