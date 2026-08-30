import { z } from "zod";

const Bar = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

const SymbolSnapshot = z.object({
  last: z.number(),
  prev_close: z.number(),
  bars_1d: z.array(Bar),
  ma20: z.number().nullable(),
  ma50: z.number().nullable(),
  ma200: z.number().nullable(),
  atr_14: z.number().nullable(),
  realized_vol_20d: z.number().nullable(),
  iv_rank: z.number().nullable(),
  volume_z_20d: z.number().nullable(),
  adv_20d: z.number().nullable(),
  tradable: z.boolean(),
  shortable: z.boolean(),
  halted: z.boolean(),
});

export const MarketSnapshot = z.object({
  schema_version: z.literal(1),
  as_of: z.string().datetime(),
  session: z.enum(["pre", "open", "post", "closed"]),
  regime: z.object({
    vix: z.number(),
    vix_source: z.literal("FRED:VIXCLS"),
    vix_as_of: z.string().datetime(),
    vix_stale_days: z.number().int().nonnegative(),
  }),
  symbols: z.record(z.string(), SymbolSnapshot),
  data_quality: z.object({
    feed: z.enum(["sip", "iex"]),
    missing: z.array(z.string()),
    stale: z.array(z.string()),
  }),
});

export type MarketSnapshot = z.infer<typeof MarketSnapshot>;
