import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { StockRecommendation } from '@trading-council/contracts';
import type { MarketSnapshot } from '@trading-council/contracts';
import {
  anthropic,
  ANTHROPIC_MODEL,
  computeAnthropicCost,
} from './anthropic-client.js';
import {
  AGENT_VERSION,
  ALLOCATOR_SYSTEM_PROMPT,
  ALLOCATOR_REVISION_SYSTEM_PROMPT,
  RECOMMENDATION_TOOL,
  REVISION_TOOL,
} from './prompts.js';
import type { AgentRunRecord } from './types.js';
import type { JevAdversaryResult, JevRiskOfficerResult } from './jev.js';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function snapshotForPrompt(snapshot: MarketSnapshot): Record<string, unknown> {
  return {
    as_of: snapshot.as_of,
    session: snapshot.session,
    regime: snapshot.regime,
    symbols: Object.fromEntries(
      Object.entries(snapshot.symbols).map(([ticker, sym]) => [
        ticker,
        {
          last: sym.last,
          prev_close: sym.prev_close,
          ma20: sym.ma20,
          ma50: sym.ma50,
          ma200: sym.ma200,
          atr_14: sym.atr_14,
          realized_vol_20d: sym.realized_vol_20d,
          iv_rank: sym.iv_rank,
          volume_z_20d: sym.volume_z_20d,
          adv_20d: sym.adv_20d,
          tradable: sym.tradable,
          shortable: sym.shortable,
          halted: sym.halted,
          fm_forecast: sym.fm_forecast ?? null,
        },
      ])
    ),
    data_quality: snapshot.data_quality,
  };
}

export interface AllocatorCallResult {
  recommendation: StockRecommendation;
  agentRunRecord: AgentRunRecord;
}

export interface RevisionCallResult {
  convictionAdjustment: number;
  rationale: string;
  maintainRecommendation: boolean;
  agentRunRecord: AgentRunRecord;
}

export async function callAllocator(
  snapshot: MarketSnapshot,
  decisionId: string,
): Promise<AllocatorCallResult> {
  const promptData = snapshotForPrompt(snapshot);
  const userContent = `Analyze this market snapshot and recommend one trade:\n\n${JSON.stringify(promptData, null, 2)}`;
  const inputHash = sha256(userContent);
  const promptVersionHash = sha256(ALLOCATOR_SYSTEM_PROMPT);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

  const start = Date.now();
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: ALLOCATOR_SYSTEM_PROMPT,
    tools: [RECOMMENDATION_TOOL],
    tool_choice: { type: 'tool', name: 'stock_recommendation' },
    messages,
  });
  const latency_ms = Date.now() - start;

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new Error('[allocator] no tool_use block in Anthropic response');

  const raw = toolUse.input as Record<string, unknown>;
  const runId = crypto.randomUUID();
  const recommendation = StockRecommendation.parse({
    ...raw,
    schema_version: 1,
    run_id: runId,
    input_hash: inputHash,
    agent_version: AGENT_VERSION,
    model: ANTHROPIC_MODEL,
  });

  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  const agentRunRecord: AgentRunRecord = {
    runId,
    decisionId,
    role: 'allocator',
    agentVersion: AGENT_VERSION,
    model: ANTHROPIC_MODEL,
    inputHash,
    promptVersionHash,
    promptRole: 'allocator',
    systemPrompt: ALLOCATOR_SYSTEM_PROMPT,
    messages,
    rawOutput: JSON.stringify(toolUse.input),
    parsedOutput: recommendation,
    schemaValid: true,
    stopReason: response.stop_reason ?? null,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: computeAnthropicCost(usage),
    latencyMs: latency_ms,
  };

  return { recommendation, agentRunRecord };
}

export async function callAllocatorRevision(
  recommendation: StockRecommendation,
  adversary: JevAdversaryResult,
  riskOfficer: JevRiskOfficerResult,
  decisionId: string,
): Promise<RevisionCallResult> {
  const userContent = `Original recommendation:\n${JSON.stringify(recommendation, null, 2)}\n\nAdversary verdict:\n${JSON.stringify(adversary, null, 2)}\n\nRisk Officer verdict:\n${JSON.stringify(riskOfficer, null, 2)}\n\nReview these critiques and decide whether to maintain your recommendation.`;
  const inputHash = sha256(userContent);
  const promptVersionHash = sha256(ALLOCATOR_REVISION_SYSTEM_PROMPT);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

  const start = Date.now();
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: ALLOCATOR_REVISION_SYSTEM_PROMPT,
    tools: [REVISION_TOOL],
    tool_choice: { type: 'tool', name: 'allocator_revision' },
    messages,
  });
  const latency_ms = Date.now() - start;

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new Error('[allocator] no tool_use block in revision response');

  const raw = toolUse.input as {
    conviction_adjustment: number;
    rationale: string;
    maintain_recommendation: boolean;
  };

  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  const runId = crypto.randomUUID();
  const agentRunRecord: AgentRunRecord = {
    runId,
    decisionId,
    role: 'allocator_revision',
    agentVersion: AGENT_VERSION,
    model: ANTHROPIC_MODEL,
    inputHash,
    promptVersionHash,
    promptRole: 'allocator',
    systemPrompt: ALLOCATOR_REVISION_SYSTEM_PROMPT,
    messages,
    rawOutput: JSON.stringify(raw),
    parsedOutput: raw,
    schemaValid: true,
    stopReason: response.stop_reason ?? null,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: computeAnthropicCost(usage),
    latencyMs: latency_ms,
  };

  return {
    convictionAdjustment: raw.conviction_adjustment ?? 0,
    rationale: raw.rationale ?? '',
    maintainRecommendation: raw.maintain_recommendation ?? true,
    agentRunRecord,
  };
}
