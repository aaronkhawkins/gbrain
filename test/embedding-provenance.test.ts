import { describe, expect, test } from 'bun:test';
import {
  buildEmbeddingSignature,
  documentPreprocessingSignature,
  parseEmbeddingSignature,
} from '../src/core/embedding-provenance.ts';

describe('embedding provenance v2', () => {
  test('round-trips full model, dimensions, column, and preprocessing identity', () => {
    const signature = buildEmbeddingSignature({
      model: 'nvidia-nim:nvidia/nemotron-3-embed-1b',
      dimensions: 2048,
      column: 'embedding',
      preprocessing: documentPreprocessingSignature(
        'nvidia-nim:nvidia/nemotron-3-embed-1b',
      ),
    });

    expect(parseEmbeddingSignature(signature)).toEqual({
      version: 2,
      model: 'nvidia-nim:nvidia/nemotron-3-embed-1b',
      dimensions: 2048,
      column: 'embedding',
      preprocessing: 'text-document-v1;input_type=passage',
    });
  });

  test('legacy signatures remain identifiable but are incomplete', () => {
    expect(parseEmbeddingSignature('openai:text-embedding-3-large:1536')).toEqual({
      version: 1,
      model: 'openai:text-embedding-3-large',
      dimensions: 1536,
      column: null,
      preprocessing: null,
    });
  });

  test('hosted and local NVIDIA identities cannot collide', () => {
    const local = buildEmbeddingSignature({
      model: 'nvidia-nim:nvidia/nemotron-3-embed-1b',
      dimensions: 2048,
      column: 'embedding',
      preprocessing: documentPreprocessingSignature(
        'nvidia-nim:nvidia/nemotron-3-embed-1b',
      ),
    });
    const hosted = buildEmbeddingSignature({
      model: 'nvidia:nvidia/llama-nemotron-embed-1b-v2',
      dimensions: 2048,
      column: 'embedding',
      preprocessing: documentPreprocessingSignature(
        'nvidia:nvidia/llama-nemotron-embed-1b-v2',
      ),
    });
    expect(local).not.toBe(hosted);
  });
});
