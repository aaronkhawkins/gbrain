import OpenAI from 'openai';
import type { EmbeddingRuntimeConfig } from './provider.ts';

let cachedClient: { apiKey: string; client: OpenAI } | null = null;

function getClient(config: EmbeddingRuntimeConfig): OpenAI {
  if (!config.apiKey) {
    throw new Error('OpenAI embedding provider selected but no OPENAI_API_KEY is configured');
  }
  if (!cachedClient || cachedClient.apiKey !== config.apiKey) {
    cachedClient = {
      apiKey: config.apiKey,
      client: new OpenAI({ apiKey: config.apiKey }),
    };
  }
  return cachedClient.client;
}

export async function embedOpenAI(texts: string[], config: EmbeddingRuntimeConfig): Promise<Float32Array[]> {
  const response = await getClient(config).embeddings.create({
    model: config.model,
    input: texts,
    dimensions: config.dimensions,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}
