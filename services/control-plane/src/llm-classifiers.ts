import Anthropic from '@anthropic-ai/sdk';
import type { StockRecommendation, MarketSnapshot } from '@trading-council/contracts';
import type { SizerOutput } from '@trading-council/sizer';
import { anthropic, ANTHROPIC_MODEL, computeAnthropicCost } from './anthropic-client.js';
import {
  ADVERSARY_SYSTEM_PROMPT,
  ADVERSARY_TOOL,
  RISK_OFFICER_SYSTEM_PROMPT,
  RISK_OFFICER_TOOL,
} from './prompts.js';
import type { AdversaryResult, RiskOfficerResult } from './types.js';

export const LLM_CLASSIFIER_MODEL = ANTHROPIC_MODEL;

export async function callLlmAdversary(
  recommendation: StockRecommendation,
  snapshot: MarketSnapshot,
): Promise<AdversaryResult> {
  const sym = snapshot.symbols[recommendation.ticker];
  const userContent = JSON.stringify(
    {
      recommendation: {
        ticker: recommendation.ticker,
        direction: recommendation.direction,
        conviction: recommendation.conviction,
        thesis: recommendation.thesis,
        est_edge_bps: recommendation.est_edge_bps,
        est_vol: recommendation.est_vol,
        horizon_days: recommendation.horizon_days,
        invalidation_condition: recommendation.invalidation_condition,
        evidence: recommendation.evidence,
      },
      market_regime: { vix: snapshot.regime.vix, session: snapshot.session },
      technicals: sym
        ? { ma20: sym.ma20, ma50: sym.ma50, realized_vol_20d: sym.realized_vol_20d }
        : null,
    },
    null,
    2,
  );

  const start = Date.now();
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: ADVERSARY_SYSTEM_PROMPT,
    tools: [ADVERSARY_TOOL],
    tool_choice: { type: 'tool', name: 'adversary_verdict' },
    messages: [{ role: 'user', content: `Review this investment thesis:\n\n${userContent}` }],
  });
  const latency_ms = Date.now() - start;

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new Error('[llm-classifiers] no tool_use in adversary response');

  const raw = toolUse.input as {
    recommend_veto: boolean;
    flaw_category: string;
    severity_score: number;
    rationale: string;
  };
  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  return {
    recommend_veto: raw.recommend_veto ?? false,
    veto_confidence: raw.recommend_veto ? 0.9 : 0.1,
    flaw_category: (raw.flaw_category ?? 'none') as AdversaryResult['flaw_category'],
    flaw_confidence: 0.9,
    severity_score: raw.severity_score ?? 0,
    rationale: raw.rationale ?? '',
    latency_ms,
    input_tokens: usage.input_tokens,
    cost_usd: computeAnthropicCost(usage),
  };
}

export async function callLlmRiskOfficer(
  recommendation: StockRecommendation,
  sizer: SizerOutput,
  snapshot: MarketSnapshot,
  portfolioNav: number,
  portfolioDrawdown: number,
  dailyPnlFraction: number,
): Promise<RiskOfficerResult> {
  const userContent = JSON.stringify(
    {
      trade: {
        ticker: recommendation.ticker,
        direction: recommendation.direction,
        bet_class: recommendation.bet_class,
        notional_usd: sizer.notional_usd,
        notional_fraction_nav: sizer.kelly_f_capped,
        est_vol: recommendation.est_vol,
        horizon_days: recommendation.horizon_days,
      },
      portfolio: {
        nav_usd: portfolioNav,
        drawdown_fraction: portfolioDrawdown,
        daily_pnl_fraction: dailyPnlFraction,
      },
      market: { vix: snapshot.regime.vix, session: snapshot.session },
    },
    null,
    2,
  );

  const start = Date.now();
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: RISK_OFFICER_SYSTEM_PROMPT,
    tools: [RISK_OFFICER_TOOL],
    tool_choice: { type: 'tool', name: 'risk_officer_verdict' },
    messages: [{ role: 'user', content: `Assess this trade intent:\n\n${userContent}` }],
  });
  const latency_ms = Date.now() - start;

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new Error('[llm-classifiers] no tool_use in risk_officer response');

  const raw = toolUse.input as {
    recommend_veto: boolean;
    breach_type: string;
    rationale: string;
  };
  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  return {
    recommend_veto: raw.recommend_veto ?? false,
    veto_confidence: raw.recommend_veto ? 0.9 : 0.1,
    breach_type: (raw.breach_type ?? 'none') as RiskOfficerResult['breach_type'],
    breach_confidence: 0.9,
    rationale: raw.rationale ?? '',
    latency_ms,
    input_tokens: usage.input_tokens,
    cost_usd: computeAnthropicCost(usage),
  };
}
