import { canonicalLookup } from '../model-pricing.ts';
import { splitProviderModelId } from '../model-id.ts';
import { getRecipe } from './recipes/index.ts';

/**
 * Estimate metered chat spend for phase-local USD caps. Canonical per-model
 * prices win; recipes provide the fallback for zero-cost local transports and
 * provider catalogs whose exact model is intentionally user supplied.
 */
export function estimateChatCostUsd(
  modelId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const canonical = canonicalLookup(modelId);
  if (canonical) {
    return (inputTokens * canonical.input + outputTokens * canonical.output) / 1_000_000;
  }
  if (!modelId) return 0;
  const { provider } = splitProviderModelId(modelId);
  const chat = provider ? getRecipe(provider)?.touchpoints.chat : undefined;
  if (
    chat?.cost_per_1m_input_usd === undefined ||
    chat.cost_per_1m_output_usd === undefined
  ) return 0;
  return (
    inputTokens * chat.cost_per_1m_input_usd +
    outputTokens * chat.cost_per_1m_output_usd
  ) / 1_000_000;
}
