import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('recipe: vllm', () => {
  test('registers an OpenAI-compatible local chat and expansion provider', () => {
    const recipe = getRecipe('vllm');
    expect(recipe).toBeDefined();
    expect(recipe!.tier).toBe('openai-compat');
    expect(recipe!.implementation).toBe('openai-compatible');
    expect(recipe!.base_url_default).toBe('http://localhost:8000/v1');
    expect(recipe!.auth_env?.required ?? []).toEqual([]);
    expect(recipe!.auth_env?.optional).toContain('VLLM_BASE_URL');
    expect(recipe!.auth_env?.optional).toContain('VLLM_API_KEY');
    expect(recipe!.touchpoints.chat?.supports_subagent_loop).toBe(false);
    expect(recipe!.touchpoints.chat?.cost_per_1m_input_usd).toBe(0);
    expect(recipe!.touchpoints.chat?.cost_per_1m_output_usd).toBe(0);
    expect(recipe!.touchpoints.expansion?.cost_per_1m_tokens_usd).toBe(0);
  });
});
