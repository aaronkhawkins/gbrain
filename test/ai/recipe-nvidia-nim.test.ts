import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';

describe('recipe: nvidia-nim', () => {
  test('registers the official fixed-dimension embedding model', () => {
    const recipe = getRecipe('nvidia-nim');
    expect(recipe).toBeDefined();
    expect(recipe!.implementation).toBe('openai-compatible');
    expect(recipe!.base_url_default).toBe('http://localhost:8000/v1');
    expect(recipe!.touchpoints.embedding?.models).toEqual([
      'nvidia/nemotron-3-embed-1b',
    ]);
    expect(recipe!.touchpoints.embedding?.default_dims).toBe(2048);
    expect(recipe!.touchpoints.embedding?.cost_per_1m_tokens_usd).toBe(0);
  });

  test('supports an optional bearer key without requiring one', () => {
    const recipe = getRecipe('nvidia-nim')!;
    expect(defaultResolveAuth(recipe, {}, 'embedding').token).toBe(
      'Bearer unauthenticated',
    );
    expect(
      defaultResolveAuth(
        recipe,
        { NVIDIA_NIM_API_KEY: 'fake-nim-key' },
        'embedding',
      ).token,
    ).toBe('Bearer fake-nim-key');
  });
});
