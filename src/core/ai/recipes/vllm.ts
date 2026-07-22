import type { Recipe } from '../types.ts';

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';

async function probeVllm(baseUrl: string, apiKey?: string): Promise<{
  reachable: boolean;
  models_endpoint_valid?: boolean;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetch(new URL('/v1/models', baseUrl).toString(), {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      return { reachable: true, models_endpoint_valid: false, error: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { reachable: true, models_endpoint_valid: false, error: 'non-JSON response' };
    }
    const isList = (body as { object?: unknown; data?: unknown }).object === 'list'
      && Array.isArray((body as { data?: unknown }).data);
    return { reachable: true, models_endpoint_valid: isList };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

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
    const result = await probeVllm(configured, process.env.VLLM_API_KEY?.trim());
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
