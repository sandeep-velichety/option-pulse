import { z } from "zod";
import { BetClass } from "./recommendation.js";

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
  qty: z.number().positive(),
  notional_usd: z.number().positive(),
  order_type: z.enum(["market", "limit"]),
  limit_price: z.number().positive().nullable(),
  time_in_force: z.literal("day"),

  bracket: z.object({
    take_profit_price: z.number().positive(),
    stop_loss_price: z.number().positive(),
  }),

  bet_class: BetClass,
  sleeve_id: z.string(),
  strategy_id: z.string(),

  sizing: z.object({
    nav_at_decision: z.number().nonnegative(),
    edge: z.number(),
    variance: z.number().nonnegative(),
    kelly_f_raw: z.number().nullable(),
    kelly_f_capped: z.number().min(0).max(0.05),
    cap_applied: z.enum([
      "kelly_cap",
      "floor",
      "asym_flat_cap",
      "asym_aggregate_cap",
      "none",
    ]),
  }),

  // Stale intents are dropped, never executed.
  expires_at: z.string().datetime(),
  status: z.enum(["pending", "claimed", "rejected", "submitted", "failed"]),
});

export type TradeIntent = z.infer<typeof TradeIntent>;
