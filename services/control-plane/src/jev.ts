import { TypeSafeClient, noul, choice, score } from '@typesafe-ai/sdk';
import type { StockRecommendation, MarketSnapshot } from '@trading-council/contracts';
import type { SizerOutput } from '@trading-council/sizer';

if (!process.env['TYPESAFE_API_KEY']) {
  throw new Error('[control-plane] TYPESAFE_API_KEY is required');
}

const jev = new TypeSafeClient();
export const JEV_MODEL = 'jev-latest';

const JEV_COST_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export interface JevAdversaryResult {
  recommend_veto: boolean;
  veto_confidence: number;
  flaw_category: 'overfit' | 'regime_change' | 'thesis_weak' | 'data_snooping' | 'none';
  flaw_confidence: number;
  severity_score: number;
  rationale: string;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
}

export interface JevRiskOfficerResult {
  recommend_veto: boolean;
  veto_confidence: number;
  breach_type: 'position_size' | 'drawdown' | 'volatility' | 'correlation' | 'none';
  breach_confidence: number;
  rationale: string;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
}

export async function callJevAdversary(
  recommendation: StockRecommendation,
  snapshot: MarketSnapshot,
): Promise<JevAdversaryResult> {
  const sym = snapshot.symbols[recommendation.ticker];
  const state = {
    ticker: recommendation.ticker,
    direction: recommendation.direction,
    conviction: recommendation.conviction,
    thesis: recommendation.thesis,
    est_edge_bps: recommendation.est_edge_bps,
    est_vol: recommendation.est_vol,
    horizon_days: recommendation.horizon_days,
    invalidation_condition: recommendation.invalidation_condition,
    evidence: recommendation.evidence,
    bet_class: recommendation.bet_class,
    market_regime: { vix: snapshot.regime.vix, session: snapshot.session },
    technicals: sym
      ? {
          last: sym.last,
          ma20: sym.ma20,
          ma50: sym.ma50,
          ma200: sym.ma200,
          realized_vol_20d: sym.realized_vol_20d,
          volume_z_20d: sym.volume_z_20d,
          fm_forecast: sym.fm_forecast ?? null,
        }
      : null,
  };

  const start = Date.now();
  const response = await jev.systemOne({
    state,
    questions: {
      veto: noul('The investment thesis contains a fatal flaw that should block this trade'),
      flaw_category: choice('Primary weakness in this thesis', {
        overfit: 'Thesis relies on data-mined or overfitted patterns unlikely to hold out-of-sample',
        regime_change: 'Current macro regime (VIX level, trend) invalidates this thesis',
        thesis_weak: 'Core logical argument is internally unsound or contradicted by the evidence',
        data_snooping: 'Evidence is cherry-picked, post-hoc rationalized, or drawn from a different period',
        none: 'No significant flaw — thesis is defensible given the available data',
      }),
      severity: score('How severe is the primary flaw?', [
        'Minor — thesis survives with minor caveats',
        'Significant — warrants caution and possible veto',
        'Fatal — thesis should definitely be vetoed',
      ]),
    },
  });
  const latency_ms = Date.now() - start;

  const vetoNoul = response.answers['veto']?.noul ?? 0;
  const flawAns = response.answers['flaw_category'];
  const severityScore = response.answers['severity']?.score ?? 0;
  const input_tokens = response.usage.input_tokens;

  return {
    recommend_veto: vetoNoul > 0.5,
    veto_confidence: vetoNoul,
    flaw_category: (flawAns?.choice ?? 'none') as JevAdversaryResult['flaw_category'],
    flaw_confidence: flawAns?.confidence ?? 0,
    severity_score: severityScore,
    rationale: `flaw=${flawAns?.choice ?? 'none'} conf=${((flawAns?.confidence ?? 0) * 100).toFixed(0)}% severity=${severityScore.toFixed(2)} veto_prob=${(vetoNoul * 100).toFixed(0)}%`,
    latency_ms,
    input_tokens,
    cost_usd: input_tokens * JEV_COST_PER_INPUT_TOKEN,
  };
}

export async function callJevRiskOfficer(
  recommendation: StockRecommendation,
  sizer: SizerOutput,
  snapshot: MarketSnapshot,
  portfolioNav: number,
  portfolioDrawdown: number,
  dailyPnlFraction: number,
): Promise<JevRiskOfficerResult> {
  const state = {
    ticker: recommendation.ticker,
    direction: recommendation.direction,
    bet_class: recommendation.bet_class,
    notional_usd: sizer.notional_usd,
    notional_fraction_nav: sizer.kelly_f_capped,
    cap_applied: sizer.cap_applied,
    est_vol: recommendation.est_vol,
    horizon_days: recommendation.horizon_days,
    portfolio: {
      nav_usd: portfolioNav,
      drawdown_fraction: portfolioDrawdown,
      daily_pnl_fraction: dailyPnlFraction,
    },
    market_regime: {
      vix: snapshot.regime.vix,
      session: snapshot.session,
    },
  };

  const start = Date.now();
  const response = await jev.systemOne({
    state,
    questions: {
      veto: noul('This trade intent breaches one or more risk rules or portfolio constraints'),
      breach_type: choice('Primary risk concern', {
        position_size: 'Position size is too large relative to portfolio or risk tolerance',
        drawdown: 'Portfolio drawdown is already too high to accept new directional risk',
        volatility: 'Asset or market volatility is too extreme for this position size',
        correlation: 'This position creates excessive concentration or correlation risk',
        none: 'No significant risk breach — trade is within acceptable policy limits',
      }),
    },
  });
  const latency_ms = Date.now() - start;

  const vetoNoul = response.answers['veto']?.noul ?? 0;
  const breachAns = response.answers['breach_type'];
  const input_tokens = response.usage.input_tokens;

  return {
    recommend_veto: vetoNoul > 0.5,
    veto_confidence: vetoNoul,
    breach_type: (breachAns?.choice ?? 'none') as JevRiskOfficerResult['breach_type'],
    breach_confidence: breachAns?.confidence ?? 0,
    rationale: `breach=${breachAns?.choice ?? 'none'} conf=${((breachAns?.confidence ?? 0) * 100).toFixed(0)}% veto_prob=${(vetoNoul * 100).toFixed(0)}%`,
    latency_ms,
    input_tokens,
    cost_usd: input_tokens * JEV_COST_PER_INPUT_TOKEN,
  };
}
