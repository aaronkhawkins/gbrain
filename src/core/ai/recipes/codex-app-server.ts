import type { Recipe } from '../types.ts';

/** Local Codex app-server using authentication owned by the Codex CLI. */
export const codexAppServer: Recipe = {
  id: 'codex-app-server',
  name: 'Codex App Server (ChatGPT login)',
  tier: 'native',
  implementation: 'codex-app-server',
  auth_env: {
    required: [],
    optional: [],
    setup_url: 'https://developers.openai.com/codex/app-server/',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      default_timeout_ms: 300_000,
      price_last_verified: '2026-08-26',
    },
    expansion: {
      models: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
      default_timeout_ms: 300_000,
      price_last_verified: '2026-08-26',
    },
  },
  setup_hint: 'Install Codex, then run `codex login` and choose Sign in with ChatGPT.',
};
