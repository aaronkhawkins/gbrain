import type { Recipe } from '../types.ts';
import { probeOpenAICompat } from '../probes.ts';

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';

/**
 * Self-hosted vLLM exposes an OpenAI-compatible chat-completions API. The
 * openai-compat tier deliberately accepts arbitrary model ids because the
 * operator controls which model the server has loaded.
 */
export const vllm: Recipe = {
  id: 'vllm',
  name: 'vLLM (self-hosted)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: DEFAULT_BASE_URL,
  auth_env: {
    required: [],
    optional: ['VLLM_BASE_URL', 'VLLM_API_KEY'],
    setup_url: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server/',
  },
  touchpoints: {
    chat: {
      models: ['nvidia/Qwen3.6-35B-A3B-NVFP4'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-22',
    },
    expansion: {
      models: ['nvidia/Qwen3.6-35B-A3B-NVFP4'],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-22',
    },
  },
  async probe(baseURL?: string) {
    const configured = baseURL ?? process.env.VLLM_BASE_URL ?? DEFAULT_BASE_URL;
    const result = await probeOpenAICompat(configured);
    if (!result.reachable || !result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `vLLM is not ready at the configured endpoint (${result.error ?? 'invalid /v1/models response'}). Start vLLM or set VLLM_BASE_URL.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Start `vllm serve <model>`, set VLLM_BASE_URL to its /v1 endpoint, and optionally set VLLM_API_KEY.',
};
