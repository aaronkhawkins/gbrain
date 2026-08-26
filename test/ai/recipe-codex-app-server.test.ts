import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('codex-app-server recipe', () => {
  test('is the zero-metered provider for GBrain-owned outer tool loops', () => {
    const recipe = getRecipe('codex-app-server');
    expect(recipe?.implementation).toBe('codex-app-server');
    expect(recipe?.auth_env?.required).toEqual([]);
    expect(recipe?.touchpoints.chat?.supports_tools).toBe(true);
    expect(recipe?.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(recipe?.touchpoints.chat?.models).toContain('gpt-5.6-sol');
    expect(recipe?.touchpoints.expansion?.models).toContain('gpt-5.6-sol');
    expect(recipe?.touchpoints.chat?.cost_per_1m_input_usd).toBe(0);
    expect(recipe?.touchpoints.chat?.cost_per_1m_output_usd).toBe(0);
  });
});
