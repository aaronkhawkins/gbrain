import { loadConfig, type GBrainConfig } from '../config.ts';

export type EmbeddingProviderName = 'ollama' | 'openai';

export interface EmbeddingRuntimeConfig {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  batchSize: number;
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3-embedding:8b';
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-large';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProvider(raw: string | undefined): EmbeddingProviderName | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'ollama' || normalized === 'openai') return normalized;
  return null;
}

function resolveFileConfig(): Partial<GBrainConfig> {
  return loadConfig() || {};
}

export function getEmbeddingRuntimeConfig(config?: Partial<GBrainConfig>): EmbeddingRuntimeConfig | null {
  const fileConfig = config || resolveFileConfig();

  const explicitProvider = normalizeProvider(process.env.GBRAIN_EMBEDDING_PROVIDER || fileConfig.embedding_provider);
  const baseUrl = process.env.GBRAIN_EMBEDDING_BASE_URL
    || process.env.OLLAMA_HOST
    || fileConfig.embedding_base_url;
  const openaiApiKey = process.env.OPENAI_API_KEY || fileConfig.openai_api_key;
  const dimensions = parsePositiveInt(
    process.env.GBRAIN_EMBEDDING_DIMENSIONS || fileConfig.embedding_dimensions,
    DEFAULT_DIMENSIONS,
  );

  const provider = explicitProvider || 'ollama';

  if (provider === 'ollama') {
    return {
      provider,
      model: process.env.GBRAIN_EMBEDDING_MODEL || fileConfig.embedding_model || DEFAULT_OLLAMA_MODEL,
      dimensions,
      baseUrl: baseUrl || DEFAULT_OLLAMA_BASE_URL,
      timeoutMs: parsePositiveInt(process.env.GBRAIN_EMBEDDING_TIMEOUT_MS, 120_000),
      batchSize: parsePositiveInt(process.env.GBRAIN_EMBEDDING_BATCH_SIZE, 32),
    };
  }

  if (!openaiApiKey) return null;

  return {
    provider,
    model: process.env.GBRAIN_EMBEDDING_MODEL || fileConfig.embedding_model || DEFAULT_OPENAI_MODEL,
    dimensions,
    apiKey: openaiApiKey,
    timeoutMs: parsePositiveInt(process.env.GBRAIN_EMBEDDING_TIMEOUT_MS, 120_000),
    batchSize: parsePositiveInt(process.env.GBRAIN_EMBEDDING_BATCH_SIZE, 100),
  };
}

export function hasEmbeddingProviderConfig(config?: Partial<GBrainConfig>): boolean {
  return getEmbeddingRuntimeConfig(config) !== null;
}

export function getDefaultEmbeddingModel(): string {
  return getEmbeddingRuntimeConfig()?.model || DEFAULT_OLLAMA_MODEL;
}

export function getDefaultEmbeddingDimensions(): number {
  return getEmbeddingRuntimeConfig()?.dimensions || DEFAULT_DIMENSIONS;
}

export function getDefaultEmbedConcurrency(): number {
  const configured = parsePositiveInt(process.env.GBRAIN_EMBED_CONCURRENCY, 0);
  if (configured > 0) return configured;
  return getEmbeddingRuntimeConfig()?.provider === 'ollama' ? 4 : 20;
}
