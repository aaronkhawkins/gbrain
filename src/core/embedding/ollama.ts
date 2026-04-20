import type { EmbeddingRuntimeConfig } from './provider.ts';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  timeout.unref?.();
  return controller.signal;
}

export async function embedOllama(texts: string[], config: EmbeddingRuntimeConfig): Promise<Float32Array[]> {
  if (!config.baseUrl) {
    throw new Error('Ollama embedding provider selected but no base URL is configured');
  }

  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      input: texts,
      dimensions: config.dimensions,
    }),
    signal: timeoutSignal(config.timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama embeddings failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = await response.json() as { embeddings?: unknown };
  if (!Array.isArray(payload.embeddings)) {
    throw new Error('Ollama embeddings response did not include an embeddings array');
  }
  if (payload.embeddings.length !== texts.length) {
    throw new Error(`Ollama returned ${payload.embeddings.length} embeddings for ${texts.length} inputs`);
  }

  return payload.embeddings.map((embedding, index) => {
    if (!Array.isArray(embedding)) {
      throw new Error(`Ollama embedding ${index} was not an array`);
    }
    if (embedding.length !== config.dimensions) {
      throw new Error(`Ollama embedding ${index} had ${embedding.length} dimensions, expected ${config.dimensions}`);
    }
    return new Float32Array(embedding as number[]);
  });
}
