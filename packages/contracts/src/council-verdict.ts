import { z } from "zod";

export const CouncilVerdict = z.object({
  run_id: z.string().uuid(),
  recommendation_id: z.string().uuid(),

  allocator: z.object({
    // Bounded adjustment only — the Allocator never outputs a dollar
    // amount or a weight, just a conviction nudge the sizer consumes.
    conviction_adjustment: z.number().min(-0.5).max(0.5),
    rationale: z.string(),
    raw_message_id: z.string(),
  }),

  adversary: z.object({
    attacks: z.array(
      z.object({
        claim: z.string(),
        severity: z.enum(["low", "medium", "high"]),
      }),
    ),
    recommend_veto: z.boolean(),
    rationale: z.string(),
  }),

  risk_officer: z.object({
    concerns: z.array(z.string()),
    recommend_veto: z.boolean(),
    rationale: z.string(),
  }),

  // Computed by code from the veto flags above — never a field an LLM sets
  // directly. See codeVetoGate() in the council orchestration module.
  verdict: z.enum(["approve", "reject"]),
  verdict_reason: z.string().nullable(),
});

export type CouncilVerdict = z.infer<typeof CouncilVerdict>;
