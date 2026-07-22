import type { Recipe } from '../types.ts';

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';

/**
 * NVIDIA NIM for the native Nemotron-3-Embed-1B retrieval model.
 *
 * The endpoint is OpenAI-compatible, but the model is asymmetric: indexed
 * content must use input_type=passage while searches use input_type=query.
 * dimsProviderOptions() owns that wire mapping and deliberately does not send
 * a `dimensions` field because this NIM serves only the native 2048-d vector.
 */
export const nvidiaNim: Recipe = {
  id: 'nvidia-nim',
  name: 'NVIDIA Embedding NIM (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: DEFAULT_BASE_URL,
  auth_env: {
    required: [],
    optional: ['NVIDIA_NIM_BASE_URL', 'NVIDIA_NIM_API_KEY'],
    setup_url: 'https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/getting-started.html',
  },
  touchpoints: {
    embedding: {
      models: ['nvidia/nemotron-3-embed-1b'],
      default_dims: 2048,
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-21',
      // NIM dynamically batches requests according to its deployment config.
      no_batch_cap: true,
      supports_multimodal: false,
    },
  },
  async probe(baseURL?: string) {
    const configured = baseURL ?? process.env.NVIDIA_NIM_BASE_URL ?? DEFAULT_BASE_URL;
    const healthURL = new URL('/v1/health/ready', configured).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(healthURL, { signal: controller.signal });
      if (!response.ok) {
        return {
          ready: false,
          hint: `NVIDIA Embedding NIM reached at ${configured}, but readiness returned HTTP ${response.status}.`,
        };
      }
      return { ready: true };
    } catch {
      return {
        ready: false,
        hint: `NVIDIA Embedding NIM is not ready at ${configured}. Start the NIM or set NVIDIA_NIM_BASE_URL.`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
  setup_hint:
    'Run nvcr.io/nim/nvidia/nemotron-3-embed-1b and set NVIDIA_NIM_BASE_URL to its /v1 endpoint.',
};
