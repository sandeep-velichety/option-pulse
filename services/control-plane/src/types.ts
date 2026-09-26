import type { StockRecommendation, GateResult } from '@trading-council/contracts';
import type { SizerOutput } from '@trading-council/sizer';

export interface AgentRunRecord {
  runId: string;
  decisionId: string;
  role: string;
  agentVersion: string;
  model: string;
  inputHash: string;
  promptVersionHash: string;
  promptRole: 'allocator' | 'risk_officer' | 'adversary';
  systemPrompt: string;
  messages: unknown[];
  rawOutput: string;
  parsedOutput: unknown;
  schemaValid: boolean;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface PendingIntentData {
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  notional_usd: number;
  last_price: number;
  bracket: { take_profit_price: number; stop_loss_price: number };
  bet_class: 'core' | 'asymmetric';
  sleeve_id: string;
  strategy_id: string;
  sizing: SizerOutput;
  sessionRunId: string;
}

export interface AdversaryResult {
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

export interface RiskOfficerResult {
  recommend_veto: boolean;
  veto_confidence: number;
  breach_type: 'position_size' | 'drawdown' | 'volatility' | 'correlation' | 'none';
  breach_confidence: number;
  rationale: string;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
}

export interface SessionResult {
  sessionRunId: string;
  decisionId: string;
  recommendation: StockRecommendation | null;
  councilVerdictEnum: 'approve' | 'reject' | 'abstain' | 'gate_rejected';
  verdictReason: string | null;
  convictionAdjustment: number;
  agentRunRecords: AgentRunRecord[];
  sizerOutput: SizerOutput | null;
  gateResult: GateResult | null;
  pendingIntent: PendingIntentData | null;
}
