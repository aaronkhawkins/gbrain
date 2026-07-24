import type { BrainEngine } from '../../src/core/engine.ts';
import {
  buildEmbeddingSignature,
  documentPreprocessingSignature,
} from '../../src/core/embedding-provenance.ts';

export const TEST_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
export const TEST_EMBEDDING_DIMENSIONS = 1536;

export function testEmbeddingSignature(
  model = TEST_EMBEDDING_MODEL,
  dimensions = TEST_EMBEDDING_DIMENSIONS,
): string {
  return buildEmbeddingSignature({
    model,
    dimensions,
    column: 'embedding',
    preprocessing: documentPreprocessingSignature(model),
  });
}

export async function stampTestEmbeddingIdentity(
  engine: BrainEngine,
  slug: string,
  model = TEST_EMBEDDING_MODEL,
  dimensions = TEST_EMBEDDING_DIMENSIONS,
): Promise<void> {
  await engine.setPageEmbeddingSignature(slug, {
    signature: testEmbeddingSignature(model, dimensions),
  });
}

/**
 * Seed a hidden, provenance-complete primary vector so hybrid-search fixtures
 * can reach the routing stage they intend to exercise. The production
 * embedding-identity gate correctly disables vector search on an empty or
 * provenance-unknown corpus; routing tests must establish a compatible corpus
 * before asserting on downstream embedding, reranker, or cache behavior.
 */
export async function seedTestEmbeddingIdentity(
  engine: BrainEngine,
  slug = 'test/embedding-identity-fixture',
): Promise<void> {
  await engine.setConfig('embedding_model', TEST_EMBEDDING_MODEL);
  await engine.setConfig('embedding_dimensions', String(TEST_EMBEDDING_DIMENSIONS));
  await engine.putPage(slug, {
    type: 'note',
    title: 'Embedding identity fixture',
    compiled_truth: 'Hidden fixture for embedding identity preflight.',
  });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: 'Hidden fixture for embedding identity preflight.',
    chunk_source: 'compiled_truth',
    embedding: new Float32Array(TEST_EMBEDDING_DIMENSIONS).fill(0.01),
    model: TEST_EMBEDDING_MODEL,
  }]);
  await stampTestEmbeddingIdentity(engine, slug);
}
