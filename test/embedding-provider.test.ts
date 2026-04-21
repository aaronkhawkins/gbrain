import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { embedBatch } from '../src/core/embedding.ts';
import {
  getDefaultEmbedConcurrency,
  getEmbeddingRuntimeConfig,
  hasEmbeddingProviderConfig,
} from '../src/core/embedding/provider.ts';

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
  delete process.env.GBRAIN_EMBEDDING_PROVIDER;
  delete process.env.GBRAIN_EMBEDDING_MODEL;
  delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  delete process.env.GBRAIN_EMBEDDING_BASE_URL;
  delete process.env.OLLAMA_HOST;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
  mock.restore();
});

afterEach(() => {
  restoreEnv();
  Object.defineProperty(globalThis, 'fetch', { value: ORIGINAL_FETCH, writable: true });
  mock.restore();
});

describe('embedding provider resolution', () => {
  test('defaults to local ollama when no provider is configured', () => {
    expect(getEmbeddingRuntimeConfig()).toEqual({
      provider: 'ollama',
      model: 'qwen3-embedding:8b',
      dimensions: 1536,
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 120000,
      batchSize: 32,
    });
    expect(hasEmbeddingProviderConfig()).toBe(true);
  });

  test('resolves explicit ollama configuration', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'qwen3-embedding:8b';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1536';
    process.env.GBRAIN_EMBEDDING_BASE_URL = 'http://skippy.local:11434';

    expect(getEmbeddingRuntimeConfig()).toEqual({
      provider: 'ollama',
      model: 'qwen3-embedding:8b',
      dimensions: 1536,
      baseUrl: 'http://skippy.local:11434',
      timeoutMs: 120000,
      batchSize: 32,
    });
    expect(hasEmbeddingProviderConfig()).toBe(true);
  });

  test('defaults to ollama even when OPENAI_API_KEY is present', () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const resolved = getEmbeddingRuntimeConfig();
    expect(resolved?.provider).toBe('ollama');
    expect(resolved?.model).toBe('qwen3-embedding:8b');
  });

  test('supports explicit openai override', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';

    expect(getEmbeddingRuntimeConfig()).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      apiKey: 'sk-test',
      timeoutMs: 120000,
      batchSize: 100,
    });
  });

  test('uses lower default concurrency for ollama', () => {
    expect(getDefaultEmbedConcurrency()).toBe(4);
  });
});

describe('ollama embedding integration', () => {
  test('calls ollama embed api and parses embeddings', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_BASE_URL = 'http://example.test:11434';
    process.env.GBRAIN_EMBEDDING_MODEL = 'qwen3-embedding:8b';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '4';

    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://example.test:11434/api/embed');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        model: 'qwen3-embedding:8b',
        input: ['hello'],
        dimensions: 4,
      });
      return new Response(JSON.stringify({
        embeddings: [[0.1, 0.2, 0.3, 0.4]],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true });

    const embeddings = await embedBatch(['hello']);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0].length).toBe(4);
    expect(embeddings[0][0]).toBeCloseTo(0.1, 5);
    expect(embeddings[0][3]).toBeCloseTo(0.4, 5);
  });

  test('throws on ollama dimension mismatch', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '4';

    Object.defineProperty(globalThis, 'fetch', { value: mock(async () => new Response(JSON.stringify({
      embeddings: [[0.1, 0.2]],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })), writable: true });

    await expect(embedBatch(['hello'])).rejects.toThrow('expected 4');
  });
});
