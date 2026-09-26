/**
 * Feature flag: USE_JEV=true routes Risk Officer + Adversary through Jev
 * (TypeSafe AI's System One classifier). Default is false because TypeSafe AI
 * has paused new signups — flip to true once you have a TYPESAFE_API_KEY.
 *
 * Both paths return identical AdversaryResult / RiskOfficerResult shapes so
 * council.ts needs no changes when the flag is toggled.
 */
export const USE_JEV = process.env['USE_JEV'] === 'true';

export type { AdversaryResult, RiskOfficerResult } from './types.js';

import type { StockRecommendation, MarketSnapshot } from '@trading-council/contracts';
import type { SizerOutput } from '@trading-council/sizer';
import type { AdversaryResult, RiskOfficerResult } from './types.js';

export async function callAdversary(
  recommendation: StockRecommendation,
  snapshot: MarketSnapshot,
): Promise<AdversaryResult> {
  if (USE_JEV) {
    const { callJevAdversary } = await import('./jev.js');
    return callJevAdversary(recommendation, snapshot);
  }
  const { callLlmAdversary } = await import('./llm-classifiers.js');
  return callLlmAdversary(recommendation, snapshot);
}

export async function callRiskOfficer(
  recommendation: StockRecommendation,
  sizer: SizerOutput,
  snapshot: MarketSnapshot,
  portfolioNav: number,
  portfolioDrawdown: number,
  dailyPnlFraction: number,
): Promise<RiskOfficerResult> {
  if (USE_JEV) {
    const { callJevRiskOfficer } = await import('./jev.js');
    return callJevRiskOfficer(recommendation, sizer, snapshot, portfolioNav, portfolioDrawdown, dailyPnlFraction);
  }
  const { callLlmRiskOfficer } = await import('./llm-classifiers.js');
  return callLlmRiskOfficer(recommendation, sizer, snapshot, portfolioNav, portfolioDrawdown, dailyPnlFraction);
}

export function classifierBackend(): string {
  return USE_JEV ? 'jev' : 'llm';
}
