import Anthropic from '@anthropic-ai/sdk';

const key = process.env['ANTHROPIC_API_KEY'];
if (!key) throw new Error('[control-plane] ANTHROPIC_API_KEY is required');

export const anthropic = new Anthropic({ apiKey: key });
export const ANTHROPIC_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-6';

const PRICE = {
  INPUT_PER_TOKEN: 3 / 1_000_000,
  OUTPUT_PER_TOKEN: 15 / 1_000_000,
  CACHE_READ_PER_TOKEN: 0.3 / 1_000_000,
  CACHE_CREATION_PER_TOKEN: 3.75 / 1_000_000,
} as const;

export function computeAnthropicCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  return (
    (usage.input_tokens - cacheRead) * PRICE.INPUT_PER_TOKEN +
    usage.output_tokens * PRICE.OUTPUT_PER_TOKEN +
    cacheRead * PRICE.CACHE_READ_PER_TOKEN +
    cacheCreate * PRICE.CACHE_CREATION_PER_TOKEN
  );
}
