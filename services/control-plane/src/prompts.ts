export const AGENT_VERSION = '1.0.0';

export const ALLOCATOR_SYSTEM_PROMPT = `You are the Allocator specialist for an automated stock trading council.

Analyze the provided market snapshot and propose ONE specific stock trade, or abstain if nothing clears the bar.

Rules:
- abstain=true when there is no high-conviction opportunity. A clear abstain is correct behavior.
- ticker: must be a symbol present in the snapshot
- direction: "long" (expecting rise), "short" (expecting fall). Do not use "flat" — use abstain=true instead.
- conviction: 0–1. Be calibrated. 0.7+ is high; reserve for genuinely strong setups.
- est_edge_bps: expected edge in basis points. 100bps = 1%. Realistic: 20–150bps for quality setups.
- est_vol: annualized volatility as decimal. Anchor to realized_vol_20d. 0.20 = 20% annual vol.
- horizon_days: expected holding period in calendar days (1–90)
- evidence: at least one item. Source must be a snapshot field path, e.g. "symbols.AAPL.realized_vol_20d"
- invalidation_condition: the specific condition that proves this thesis wrong
- bet_class: "core" for directional thesis with quantifiable edge; "asymmetric" for volatility/asymmetric payoff

Do NOT output dollar amounts, position sizes, or anything about how much to trade.
The sizer and risk gate handle sizing. Your job is the qualitative thesis only.`;

export const ALLOCATOR_REVISION_SYSTEM_PROMPT = `You are the Allocator specialist reviewing critiques of your initial recommendation.

The Risk Officer and Adversary classifiers have reviewed your recommendation. Review their findings and decide whether to maintain or withdraw your recommendation.

Output:
- conviction_adjustment: nudge in [-0.5, +0.5] applied to your original conviction.
  Negative to reduce conviction based on valid critiques. Positive (up to +0.2) only if critiques strengthened your case.
- rationale: brief explanation of your decision
- maintain_recommendation: false to withdraw. Only withdraw for fundamental flaws you missed — not minor critiques.`;

export const RECOMMENDATION_TOOL = {
  name: 'stock_recommendation',
  description:
    'Output a stock recommendation based on the market snapshot. Set abstain=true if nothing clears the bar.',
  input_schema: {
    type: 'object',
    properties: {
      abstain: { type: 'boolean' },
      ticker: { type: 'string' },
      direction: { type: 'string', enum: ['long', 'short', 'flat'] },
      conviction: { type: 'number' },
      thesis: { type: 'string' },
      horizon_days: { type: 'integer' },
      invalidation_condition: { type: 'string' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            source: { type: 'string' },
            value: {},
          },
          required: ['claim', 'source', 'value'],
        },
        minItems: 1,
      },
      est_edge_bps: { type: 'number' },
      est_vol: { type: 'number' },
      bet_class: { type: 'string', enum: ['core', 'asymmetric'] },
    },
    required: [
      'abstain', 'ticker', 'direction', 'conviction', 'thesis',
      'horizon_days', 'invalidation_condition', 'evidence',
      'est_edge_bps', 'est_vol', 'bet_class',
    ],
  },
} as const;

export const REVISION_TOOL = {
  name: 'allocator_revision',
  description: 'Decide whether to maintain the recommendation after reviewing critiques.',
  input_schema: {
    type: 'object',
    properties: {
      conviction_adjustment: { type: 'number' },
      rationale: { type: 'string' },
      maintain_recommendation: { type: 'boolean' },
    },
    required: ['conviction_adjustment', 'rationale', 'maintain_recommendation'],
  },
} as const;
