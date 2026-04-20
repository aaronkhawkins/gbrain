import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  restoreEnv();
  delete process.env.OPENAI_API_KEY;
  process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
  process.env.GBRAIN_EMBEDDING_DIMENSIONS = '3';
});

afterEach(() => {
  restoreEnv();
  Object.defineProperty(globalThis, 'fetch', { value: ORIGINAL_FETCH, writable: true });
  mock.restore();
});

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_, prop: string) {
      if (prop in overrides) return overrides[prop];
      return async () => null;
    },
  });
}

describe('hybridSearch with ollama configured', () => {
  test('runs vector search without OPENAI_API_KEY', async () => {
    const searchVector = mock(async () => [{
      slug: 'people/test',
      page_id: 1,
      title: 'Test',
      type: 'person',
      chunk_text: 'vector result',
      chunk_source: 'compiled_truth',
      chunk_id: 11,
      chunk_index: 0,
      score: 0.95,
      stale: false,
    }]);

    const { hybridSearch } = await import('../src/core/search/hybrid.ts');
    Object.defineProperty(globalThis, 'fetch', {
      value: mock(async () => new Response(JSON.stringify({
        embeddings: [[0.1, 0.2, 0.3]],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
      writable: true,
    });

    const engine = mockEngine({
      searchKeyword: async () => [],
      searchVector,
      getEmbeddingsByChunkIds: async () => new Map([[11, new Float32Array([0.1, 0.2, 0.3])]]),
      getBacklinkCounts: async () => new Map<string, number>(),
    });

    const results = await hybridSearch(engine, 'hello world query', { limit: 5 });
    expect(searchVector).toHaveBeenCalledTimes(1);
    expect(results[0]?.slug).toBe('people/test');
  });
});
