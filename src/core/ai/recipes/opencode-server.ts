import type { Recipe } from '../types.ts';

/**
 * OpenCode's persistent local server, using credentials owned and refreshed by
 * OpenCode. This is intentionally separate from the OpenCode Zen HTTP API.
 */
export const opencodeServer: Recipe = {
  id: 'opencode-server',
  name: 'OpenCode Server (local OAuth)',
  tier: 'native',
  implementation: 'opencode-server',
  auth_env: {
    required: ['GBRAIN_OPENCODE_SERVER_PASSWORD'],
    optional: [
      'GBRAIN_OPENCODE_SERVER_URL',
      'GBRAIN_OPENCODE_SERVER_USERNAME',
      'GBRAIN_OPENCODE_PROVIDER_ID',
      'GBRAIN_OPENCODE_AGENT',
    ],
    setup_url: 'https://opencode.ai/docs/server/',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.5-fast', 'gpt-5.4', 'gpt-5.4-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      // OpenCode uses Aaron's subscription-backed local OAuth session. GBrain
      // incurs no metered per-token API charge through this transport.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-10',
    },
    expansion: {
      models: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol'],
      price_last_verified: '2026-07-10',
    },
  },
  setup_hint:
    'Run `opencode providers login --provider OpenAI`, then keep an authenticated local-only ' +
    '`opencode serve` process running. Set GBRAIN_OPENCODE_SERVER_PASSWORD; other connection settings live in ' +
    'GBRAIN_OPENCODE_SERVER_URL/USERNAME/PASSWORD/PROVIDER_ID/AGENT.',
};
