import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { withEnv } from '../helpers/with-env.ts';

async function withModelsServer(
  handler: (request: Request) => Response,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: handler });
  try {
    await run(`http://127.0.0.1:${server.port}/v1`);
  } finally {
    server.stop(true);
  }
}

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

  test('readiness probe omits authorization when VLLM_API_KEY is unset', async () => {
    await withEnv({ VLLM_API_KEY: undefined }, async () => {
      await withModelsServer(
        (request) => {
          expect(request.headers.get('authorization')).toBeNull();
          return Response.json({ object: 'list', data: [] });
        },
        async (baseUrl) => {
          expect(await getRecipe('vllm')!.probe!(baseUrl)).toEqual({ ready: true });
        },
      );
    });
  });

  test('readiness probe sends VLLM_API_KEY as bearer authorization', async () => {
    await withEnv({ VLLM_API_KEY: 'test-vllm-token' }, async () => {
      await withModelsServer(
        (request) => {
          expect(request.headers.get('authorization')).toBe('Bearer test-vllm-token');
          return Response.json({ object: 'list', data: [] });
        },
        async (baseUrl) => {
          expect(await getRecipe('vllm')!.probe!(baseUrl)).toEqual({ ready: true });
        },
      );
    });
  });
});
