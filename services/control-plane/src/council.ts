import crypto from 'node:crypto';
import { riskGate, kellySizer } from '@trading-council/sizer';
import type { PortfolioState } from '@trading-council/sizer';
import type { MarketSnapshot, TradeIntent } from '@trading-council/contracts';
import { callAllocator, callAllocatorRevision } from './allocator.js';
import { callJevAdversary, callJevRiskOfficer, JEV_MODEL } from './jev.js';
import type { JevAdversaryResult, JevRiskOfficerResult } from './jev.js';
import { AGENT_VERSION } from './prompts.js';
import type { AgentRunRecord, SessionResult, PendingIntentData } from './types.js';

export const STRATEGY_ID = 'default-stock-v1';
export const SLEEVE_ID = 'default-sleeve';

function codeVetoGate(adversaryVeto: boolean, riskOfficerVeto: boolean): 'approve' | 'reject' {
  return adversaryVeto || riskOfficerVeto ? 'reject' : 'approve';
}

function buildBracket(
  last: number,
  direction: 'long' | 'short',
  atr_14: number | null,
): { take_profit_price: number; stop_loss_price: number } {
  const atrFraction = atr_14 != null ? atr_14 / last : 0.02;
  const stopDist = Math.max(atrFraction, 0.015);
  const targetDist = stopDist * 2.5;

  if (direction === 'long') {
    return {
      take_profit_price: parseFloat((last * (1 + targetDist)).toFixed(4)),
      stop_loss_price: parseFloat((last * (1 - stopDist)).toFixed(4)),
    };
  }
  return {
    take_profit_price: parseFloat((last * (1 - targetDist)).toFixed(4)),
    stop_loss_price: parseFloat((last * (1 + stopDist)).toFixed(4)),
  };
}

function buildTradeIntentForGate(
  recommendation: {
    ticker: string;
    direction: 'long' | 'short';
    bet_class: 'core' | 'asymmetric';
  },
  sizing: ReturnType<typeof kellySizer>,
  decisionId: string,
  sessionRunId: string,
): TradeIntent {
  const side = recommendation.direction === 'long' ? 'buy' : 'sell';
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  return {
    schema_version: 1,
    intent_id: crypto.randomUUID(),
    run_id: sessionRunId,
    decision_id: decisionId,
    client_order_id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
    ticker: recommendation.ticker,
    side,
    qty: sizing.nav_at_decision > 0 ? sizing.notional_usd / 1 : 0,
    notional_usd: sizing.notional_usd,
    order_type: 'market',
    limit_price: null,
    time_in_force: 'day',
    bracket: { take_profit_price: 1, stop_loss_price: 1 },
    bet_class: recommendation.bet_class,
    sleeve_id: SLEEVE_ID,
    strategy_id: STRATEGY_ID,
    sizing: {
      nav_at_decision: sizing.nav_at_decision,
      edge: sizing.edge,
      variance: sizing.variance,
      kelly_f_raw: sizing.kelly_f_raw,
      kelly_f_capped: sizing.kelly_f_capped,
      cap_applied: sizing.cap_applied,
    },
    expires_at: expiresAt,
    status: 'pending',
  };
}

function buildJevAgentRunRecord(
  runId: string,
  decisionId: string,
  role: 'risk_officer' | 'adversary',
  result: JevAdversaryResult | JevRiskOfficerResult,
  stateJson: string,
): AgentRunRecord {
  const inputHash = crypto.createHash('sha256').update(stateJson).digest('hex');
  const promptVersionHash = inputHash;
  return {
    runId,
    decisionId,
    role: `${role}_jev`,
    agentVersion: AGENT_VERSION,
    model: JEV_MODEL,
    inputHash,
    promptVersionHash,
    promptRole: role,
    systemPrompt: stateJson,
    messages: [{ role: 'user', content: stateJson }],
    rawOutput: JSON.stringify(result),
    parsedOutput: result,
    schemaValid: true,
    stopReason: null,
    inputTokens: result.input_tokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: result.cost_usd,
    latencyMs: result.latency_ms,
  };
}

export async function runCouncil(
  snapshot: MarketSnapshot,
  portfolio: PortfolioState,
  sessionRunId: string,
  decisionId: string,
): Promise<SessionResult> {
  const agentRunRecords: AgentRunRecord[] = [];

  // Step 1: Allocator (Anthropic) — thesis generation
  const { recommendation, agentRunRecord: allocatorRun } = await callAllocator(
    snapshot,
    decisionId,
  );
  agentRunRecords.push(allocatorRun);

  if (recommendation.abstain || recommendation.direction === 'flat') {
    return {
      sessionRunId,
      decisionId,
      recommendation,
      councilVerdictEnum: 'abstain',
      verdictReason: 'Allocator abstained — no compelling opportunity',
      convictionAdjustment: 0,
      agentRunRecords,
      sizerOutput: null,
      gateResult: null,
      pendingIntent: null,
    };
  }

  // Step 2: Jev classifiers — Risk Officer + Adversary in parallel
  const direction = recommendation.direction as 'long' | 'short';

  // Pre-size so Risk Officer Jev can evaluate the actual notional
  const preSizing = kellySizer(recommendation, 0, portfolio.currentNav, portfolio.asymmetricNotionalOpen);

  const drawdown =
    portfolio.peakNav > 0 ? 1 - portfolio.currentNav / portfolio.peakNav : 0;
  const dailyPnlFraction =
    portfolio.currentNav > 0 ? portfolio.dailyPnlUsd / portfolio.currentNav : 0;

  const [adversaryResult, riskOfficerResult] = await Promise.all([
    callJevAdversary(recommendation, snapshot),
    callJevRiskOfficer(
      recommendation,
      preSizing,
      snapshot,
      portfolio.currentNav,
      drawdown,
      dailyPnlFraction,
    ),
  ]);

  const adversaryRunId = crypto.randomUUID();
  const riskOfficerRunId = crypto.randomUUID();
  agentRunRecords.push(
    buildJevAgentRunRecord(
      adversaryRunId,
      decisionId,
      'adversary',
      adversaryResult,
      JSON.stringify({ ticker: recommendation.ticker, thesis: recommendation.thesis }),
    ),
  );
  agentRunRecords.push(
    buildJevAgentRunRecord(
      riskOfficerRunId,
      decisionId,
      'risk_officer',
      riskOfficerResult,
      JSON.stringify({ notional: preSizing.notional_usd, portfolio: { drawdown, dailyPnlFraction } }),
    ),
  );

  // Step 3: codeVetoGate (pure function — no LLM)
  const gateVerdict = codeVetoGate(
    adversaryResult.recommend_veto,
    riskOfficerResult.recommend_veto,
  );

  // Step 4: Allocator revision — only if a veto was raised
  let convictionAdjustment = 0;
  let maintainRecommendation = true;

  if (gateVerdict === 'reject') {
    const revision = await callAllocatorRevision(
      recommendation,
      adversaryResult,
      riskOfficerResult,
      decisionId,
    );
    agentRunRecords.push(revision.agentRunRecord);
    convictionAdjustment = revision.convictionAdjustment;
    maintainRecommendation = revision.maintainRecommendation;

    if (!maintainRecommendation) {
      return {
        sessionRunId,
        decisionId,
        recommendation,
        councilVerdictEnum: 'reject',
        verdictReason: `Allocator withdrew: adversary=${adversaryResult.flaw_category} risk=${riskOfficerResult.breach_type}`,
        convictionAdjustment,
        agentRunRecords,
        sizerOutput: null,
        gateResult: null,
        pendingIntent: null,
      };
    }
  }

  // Step 5: Final sizing with conviction adjustment
  const finalSizing = kellySizer(
    recommendation,
    convictionAdjustment,
    portfolio.currentNav,
    portfolio.asymmetricNotionalOpen,
  );

  if (finalSizing.notional_usd <= 0) {
    return {
      sessionRunId,
      decisionId,
      recommendation,
      councilVerdictEnum: 'gate_rejected',
      verdictReason: 'Sizer produced zero notional after conviction adjustment',
      convictionAdjustment,
      agentRunRecords,
      sizerOutput: finalSizing,
      gateResult: null,
      pendingIntent: null,
    };
  }

  // Step 6: Risk gate (pure function)
  const intentForGate = buildTradeIntentForGate(
    { ticker: recommendation.ticker, direction, bet_class: recommendation.bet_class },
    finalSizing,
    decisionId,
    sessionRunId,
  );
  const gateResult = riskGate(intentForGate, snapshot, portfolio);

  if (!gateResult.allow) {
    return {
      sessionRunId,
      decisionId,
      recommendation,
      councilVerdictEnum: 'gate_rejected',
      verdictReason: `Risk gate blocked: ${gateResult.reason ?? 'unknown'}`,
      convictionAdjustment,
      agentRunRecords,
      sizerOutput: finalSizing,
      gateResult,
      pendingIntent: null,
    };
  }

  // Step 7: Assemble pending intent
  const sym = snapshot.symbols[recommendation.ticker];
  if (!sym) {
    return {
      sessionRunId,
      decisionId,
      recommendation,
      councilVerdictEnum: 'gate_rejected',
      verdictReason: `${recommendation.ticker} not in snapshot`,
      convictionAdjustment,
      agentRunRecords,
      sizerOutput: finalSizing,
      gateResult,
      pendingIntent: null,
    };
  }

  const last = sym.last;
  const side: 'buy' | 'sell' = direction === 'long' ? 'buy' : 'sell';
  const qty = last > 0 ? finalSizing.notional_usd / last : 0;
  const bracket = buildBracket(last, direction, sym.atr_14);

  const pendingIntent: PendingIntentData = {
    ticker: recommendation.ticker,
    side,
    qty,
    notional_usd: finalSizing.notional_usd,
    last_price: last,
    bracket,
    bet_class: recommendation.bet_class,
    sleeve_id: SLEEVE_ID,
    strategy_id: STRATEGY_ID,
    sizing: finalSizing,
    sessionRunId,
  };

  return {
    sessionRunId,
    decisionId,
    recommendation,
    councilVerdictEnum: 'approve',
    verdictReason: null,
    convictionAdjustment,
    agentRunRecords,
    sizerOutput: finalSizing,
    gateResult,
    pendingIntent,
  };
}
