import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectEmbeddingIdentity } from '../src/core/search/embedding-identity.ts';
import { hybridSearch, hybridSearchCached } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => engine.disconnect());
beforeEach(async () => resetPgliteState(engine));

const resolved = {
  name: 'embedding',
  type: 'vector' as const,
  dimensions: 1536,
  embeddingModel: 'openai:text-embedding-3-large',
};

async function seedEmbedded(model = 'text-embedding-3-large'): Promise<void> {
  const qualifiedModel = model.includes(':') ? model : `openai:${model}`;
  await engine.putPage('concepts/searchable', {
    type: 'concept',
    title: 'Searchable',
    compiled_truth: 'A searchable concept.',
    chunker_version: 3,
  });
  await engine.upsertChunks('concepts/searchable', [{
    chunk_index: 0,
    chunk_text: 'A searchable concept.',
    chunk_source: 'compiled_truth',
    embedding: new Float32Array(1536).fill(0.01),
    model: qualifiedModel,
  }]);
  await engine.setPageEmbeddingSignature('concepts/searchable', {
    signature: `v2|model=${encodeURIComponent(qualifiedModel)}|dimensions=1536|column=embedding|preprocessing=text-document-v1`,
  });
}

describe('embedding identity fail-closed diagnostics', () => {
  test('allows vector retrieval only when runtime, DB, column and stored provenance agree', async () => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    await engine.setConfig('embedding_dimensions', '1536');
    await seedEmbedded();

    const result = await inspectEmbeddingIdentity(engine, resolved);
    expect(result.status).toBe('compatible');
    expect(result.vectorSearchAllowed).toBe(true);
    expect(result.observed.chunkModels).toEqual(['openai:text-embedding-3-large']);
    expect(result.observed.chunkerVersions).toEqual([3]);
  });

  test('legacy or missing page provenance is an explicit fail-closed cohort', async () => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    await engine.setConfig('embedding_dimensions', '1536');
    await seedEmbedded();
    await engine.setPageEmbeddingSignature('concepts/searchable', {
      signature: 'openai:text-embedding-3-large:1536',
    });

    const legacy = await inspectEmbeddingIdentity(engine, resolved);
    expect(legacy.status).toBe('incompatible');
    expect(legacy.vectorSearchAllowed).toBe(false);
    expect(legacy.disagreements).toContain('stored page embedding signature is legacy or incomplete');

    await engine.executeRaw(
      `UPDATE pages SET embedding_signature = NULL WHERE slug = 'concepts/searchable'`,
    );
    const missing = await inspectEmbeddingIdentity(engine, resolved);
    expect(missing.status).toBe('incompatible');
    expect(missing.vectorSearchAllowed).toBe(false);
    expect(missing.disagreements).toContain('stored page embedding provenance is missing');
  });

  test('equal-width vectors with different preprocessing fail closed', async () => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    await engine.setConfig('embedding_dimensions', '1536');
    await seedEmbedded();
    await engine.setPageEmbeddingSignature('concepts/searchable', {
      signature: `v2|model=${encodeURIComponent('openai:text-embedding-3-large')}|dimensions=1536|column=embedding|preprocessing=query-v1`,
    });

    const result = await inspectEmbeddingIdentity(engine, resolved);
    expect(result.status).toBe('incompatible');
    expect(result.vectorSearchAllowed).toBe(false);
    expect(result.disagreements).toContain('stored page embedding signature disagrees with runtime');
  });

  test('same dimensions cannot hide a provider/model conflict', async () => {
    await engine.setConfig('embedding_model', 'ollama:nomic-embed-text');
    await engine.setConfig('embedding_dimensions', '1536');
    await seedEmbedded('zeroentropyai:zembed-1');

    const result = await inspectEmbeddingIdentity(engine, resolved);
    expect(result.status).toBe('incompatible');
    expect(result.vectorSearchAllowed).toBe(false);
    expect(result.disagreements).toContain('runtime model disagrees with database selection');
    expect(result.disagreements).toContain('stored vector model disagrees with runtime');
  });

  test('hybrid search reports identity refusal and still returns lexical evidence', async () => {
    await engine.setConfig('embedding_model', 'ollama:nomic-embed-text');
    await engine.setConfig('embedding_dimensions', '1536');
    await seedEmbedded('zeroentropyai:zembed-1');
    let meta: HybridSearchMeta | undefined;

    const results = await hybridSearch(engine, 'searchable concept', {
      limit: 5,
      onMeta: (value) => { meta = value; },
    });

    expect(results.map((row) => row.slug)).toContain('concepts/searchable');
    expect(meta?.vector_enabled).toBe(false);
    expect(meta?.vector_disabled_reason).toBe('embedding_identity_incompatible');
  });

  test('cached hybrid search checks identity before query embedding or cache lookup', async () => {
    await engine.setConfig('embedding_model', 'ollama:nomic-embed-text');
    await engine.setConfig('embedding_dimensions', '1536');
    await seedEmbedded('zeroentropyai:zembed-1');
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('embedding provider must not be called');
    }) as unknown as typeof fetch;
    let meta: HybridSearchMeta | undefined;

    try {
      const results = await hybridSearchCached(engine, 'searchable concept', {
        limit: 5,
        useCache: true,
        onMeta: (value) => { meta = value; },
      });

      expect(results.map((row) => row.slug)).toContain('concepts/searchable');
      expect(meta?.cache?.status).toBe('disabled');
      expect(meta?.vector_enabled).toBe(false);
      expect(meta?.vector_disabled_reason).toBe('embedding_identity_incompatible');
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('empty and non-primary spaces fail closed without writing vectors', async () => {
    const empty = await inspectEmbeddingIdentity(engine, resolved);
    expect(empty.status).toBe('empty');
    expect(empty.vectorSearchAllowed).toBe(false);

    const alternative = await inspectEmbeddingIdentity(engine, {
      ...resolved,
      name: 'embedding_experiment',
    });
    expect(alternative.status).toBe('unknown');
    expect(alternative.vectorSearchAllowed).toBe(false);
  });
});
