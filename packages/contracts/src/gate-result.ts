import { z } from "zod";

// riskGate() returns every check, not just the first failure — the
// decision journal needs the full evaluation, not just the reason it
// stopped at.
export const GateResult = z.object({
  allow: z.boolean(),
  reason: z.string().nullable(),
  checks: z.array(
    z.object({
      name: z.string(),
      pass: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});

export type GateResult = z.infer<typeof GateResult>;
