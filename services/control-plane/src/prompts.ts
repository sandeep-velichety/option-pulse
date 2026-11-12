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
The sizer and risk gate handle sizing. Your job is the qualitative thesis only.

The snapshot may include a \`macro_context\` block with:
- \`fear_greed_index\` (0–100): market sentiment. < 25 = extreme fear (potential contrarian long), > 75 = extreme greed (risk-off, tighten conviction). null if unavailable.
- \`fear_greed_label\`: human label (Extreme Fear, Fear, Neutral, Greed, Extreme Greed).
Use this as a regime filter — it does not override technicals but adds weight to your conviction direction.

Each symbol may also include an \`fm_forecast\` field (null when the forecaster service is offline):
- \`point\`: TimesFM model price prediction at horizon_days
- \`q10\` / \`q90\`: 10th/90th percentile bounds — a wide spread signals high model uncertainty
- \`horizon_days\`: forecast horizon in calendar days
When fm_forecast is present, treat it as a quantitative prior. If the model's point forecast aligns with your technical thesis, it adds modest conviction. If it contradicts, flag it in your reasoning and reduce conviction. Never cite fm_forecast as the sole basis for a trade — it corroborates or challenges, it does not decide.`;

export const CRYPTO_ALLOCATOR_SYSTEM_PROMPT = `You are the Allocator specialist for an automated crypto trading council.

Analyze the provided market snapshot and propose ONE specific crypto trade, or abstain if nothing clears the bar.
Crypto markets trade 24/7 — there is no opening bell constraint.

Rules:
- abstain=true when there is no high-conviction opportunity. A clear abstain is correct behavior.
- ticker: must be a symbol present in the snapshot (e.g. BTC/USD, ETH/USD)
- direction: "long" only — short selling is not supported on Alpaca paper for crypto.
- conviction: 0–1. Be calibrated. 0.7+ is high; reserve for genuinely strong setups.
- est_edge_bps: expected edge in basis points. Crypto is volatile — realistic range: 50–300bps.
- est_vol: annualized volatility as decimal. Anchor to realized_vol_20d. BTC ~0.60, ETH ~0.70 typical.
- horizon_days: expected holding period in calendar days (1–30). Crypto moves fast.
- evidence: at least one item. Source must be a snapshot field path, e.g. "symbols.BTC/USD.realized_vol_20d"
- invalidation_condition: the specific condition that proves this thesis wrong
- bet_class: "asymmetric" for most crypto bets given the volatility profile; "core" only for high-conviction trend trades

Do NOT output dollar amounts, position sizes, or anything about how much to trade.
The sizer and risk gate handle sizing. Your job is the qualitative thesis only.

The snapshot may include a \`macro_context\` block with:
- \`fear_greed_index\` (0–100): crypto market sentiment. < 25 = extreme fear (potential contrarian long), > 75 = extreme greed (be cautious). null if unavailable.
- \`fear_greed_label\`: human label.
- \`crypto_headlines\`: up to 8 recent hot headlines from CryptoPanic with sentiment tags. Summarise any clearly relevant catalysts in your thesis.
Use macro_context to sharpen or dampen conviction — it does not replace the technical analysis.

Each symbol may also include an \`fm_forecast\` field (null when the forecaster service is offline):
- \`point\`: TimesFM model price prediction at horizon_days
- \`q10\` / \`q90\`: 10th/90th percentile bounds — a wide spread signals high model uncertainty
- \`horizon_days\`: forecast horizon in calendar days
When fm_forecast is present, treat it as a quantitative prior. If the model's point forecast aligns with your technical thesis, it adds modest conviction. If it contradicts, flag it in your reasoning and reduce conviction. Never cite fm_forecast as the sole basis for a trade — it corroborates or challenges, it does not decide.`;

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

export const ADVERSARY_SYSTEM_PROMPT = `You are the Adversary specialist for a trading council. Your job is to find fatal flaws in investment theses.

Review the thesis with skepticism. Look for: overfitted or data-mined patterns, macro regime mismatches, logically unsound arguments, cherry-picked evidence.

Be decisive. Most mediocre theses should be vetoed. Only clear, well-supported theses should pass.

Missing inputs are not evidence. If a field is unavailable (for example \`vix: null\` / \`vix_available: false\`), that is a data gap in the pipeline: do NOT veto, and do NOT cite regime_change, solely because of it. Judge the thesis on the data actually provided.`;

export const ADVERSARY_TOOL = {
  name: 'adversary_verdict',
  description: 'Output your adversarial assessment of this investment thesis.',
  input_schema: {
    type: 'object',
    properties: {
      recommend_veto: { type: 'boolean', description: 'true if this thesis has a fatal flaw' },
      flaw_category: {
        type: 'string',
        enum: ['overfit', 'regime_change', 'thesis_weak', 'data_snooping', 'none'],
        description: 'Primary flaw type, or none if thesis survives scrutiny',
      },
      severity_score: {
        type: 'number',
        description: '0=minor, 1=significant, 2=fatal',
      },
      rationale: { type: 'string', description: 'One or two sentences explaining your verdict' },
    },
    required: ['recommend_veto', 'flaw_category', 'severity_score', 'rationale'],
  },
} as const;

export const RISK_OFFICER_SYSTEM_PROMPT = `You are the Risk Officer for a trading council. Your job is to identify whether a proposed trade breaches portfolio risk rules.

Assess: position size relative to NAV, current drawdown level, market volatility, and concentration risk.

Be precise. Flag genuine breaches. Do not veto trades for minor concerns the risk gate will already catch. Unavailable data (for example \`vix: null\`) is a data gap, not a breach.`;

export const RISK_OFFICER_TOOL = {
  name: 'risk_officer_verdict',
  description: 'Output your risk assessment of this proposed trade.',
  input_schema: {
    type: 'object',
    properties: {
      recommend_veto: { type: 'boolean', description: 'true if this trade breaches risk rules' },
      breach_type: {
        type: 'string',
        enum: ['position_size', 'drawdown', 'volatility', 'correlation', 'none'],
        description: 'Primary risk concern, or none if trade is within policy',
      },
      rationale: { type: 'string', description: 'One or two sentences explaining your verdict' },
    },
    required: ['recommend_veto', 'breach_type', 'rationale'],
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
