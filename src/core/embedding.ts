/**
 * Embedding facade.
 *
 * Keeps the public API stable while routing to the configured provider.
 * Providers:
 * - OpenAI
 * - Ollama
 */

import OpenAI from 'openai';
import { embedOllama } from './embedding/ollama.ts';
import { embedOpenAI } from './embedding/openai.ts';
import {
  getDefaultEmbeddingDimensions,
  getDefaultEmbeddingModel,
  getEmbeddingRuntimeConfig,
  type EmbeddingRuntimeConfig,
} from './embedding/provider.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const config = getEmbeddingRuntimeConfig();
  if (!config) {
    throw new Error('No embedding provider configured');
  }

  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += config.batchSize) {
    const batch = truncated.slice(i, i + config.batchSize);
    const batchResults = await embedBatchWithRetry(batch, config);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  config: EmbeddingRuntimeConfig,
): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (config.provider === 'ollama') {
        return await embedOllama(texts, config);
      }
      return await embedOpenAI(texts, config);
    } catch (e: unknown) {
      if (!shouldRetryEmbeddingError(config, e)) throw e;
      if (attempt === MAX_RETRIES - 1) throw e;

      let delay = exponentialDelay(attempt);

      if (config.provider === 'openai' && e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!Number.isNaN(parsed)) {
            delay = parsed * 1000;
          }
        }
      }

      await sleep(delay);
    }
  }

  throw new Error('Embedding failed after all retries');
}

function shouldRetryEmbeddingError(config: EmbeddingRuntimeConfig, error: unknown): boolean {
  if (config.provider !== 'ollama') return true;
  if (!(error instanceof Error)) return true;

  // Provider validation and shape errors are deterministic. Retrying only burns
  // time and makes local misconfiguration feel hung.
  return !(
    error.message.includes('did not include an embeddings array')
    || error.message.includes('returned ')
    || error.message.includes('was not an array')
    || error.message.includes('dimensions, expected')
  );
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const EMBEDDING_MODEL = getDefaultEmbeddingModel();
export const EMBEDDING_DIMENSIONS = getDefaultEmbeddingDimensions();
export { getEmbeddingRuntimeConfig } from './embedding/provider.ts';
