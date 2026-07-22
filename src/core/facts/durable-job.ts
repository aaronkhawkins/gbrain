import { createHash } from 'node:crypto';

export interface FactsAbsorbJobData extends Record<string, unknown> {
  schema_version: 1;
  slug: string;
  sourceId: string;
  sessionId: string | null;
  source: 'sync:import' | 'mcp:put_page' | 'mcp:extract_facts' | 'file_upload' | 'code_import';
  notabilityFilter: 'all' | 'high-only';
  contentHash: string;
}

export const FACTS_ABSORB_JOB_SCHEMA_VERSION = 1 as const;

const FACTS_SOURCES = new Set<FactsAbsorbJobData['source']>([
  'sync:import',
  'mcp:put_page',
  'mcp:extract_facts',
  'file_upload',
  'code_import',
]);

/** Validate the persisted trust-boundary payload, while accepting legacy v1 omissions. */
export function parseFactsAbsorbJobData(value: unknown): FactsAbsorbJobData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('facts-absorb: payload must be an object');
  }
  const data = value as Record<string, unknown>;
  const schemaVersion = data.schema_version ?? FACTS_ABSORB_JOB_SCHEMA_VERSION;
  if (schemaVersion !== FACTS_ABSORB_JOB_SCHEMA_VERSION) {
    throw new Error(`facts-absorb: unsupported payload schema_version ${String(schemaVersion)}`);
  }
  if (typeof data.slug !== 'string' || data.slug.length === 0) {
    throw new Error('facts-absorb: slug is required');
  }
  const sourceId = data.sourceId ?? 'default';
  if (typeof sourceId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(sourceId)) {
    throw new Error('facts-absorb: sourceId must match [a-z0-9-]{1,32}');
  }
  const sessionId = data.sessionId ?? null;
  if (sessionId !== null && typeof sessionId !== 'string') {
    throw new Error('facts-absorb: sessionId must be a string or null');
  }
  const source = data.source ?? 'sync:import';
  if (typeof source !== 'string' || !FACTS_SOURCES.has(source as FactsAbsorbJobData['source'])) {
    throw new Error(`facts-absorb: unsupported source ${String(source)}`);
  }
  const notabilityFilter = data.notabilityFilter ?? 'all';
  if (notabilityFilter !== 'all' && notabilityFilter !== 'high-only') {
    throw new Error(`facts-absorb: unsupported notabilityFilter ${String(notabilityFilter)}`);
  }
  const contentHash = data.contentHash ?? '';
  if (typeof contentHash !== 'string' || (contentHash !== '' && !/^[a-f0-9]{64}$/.test(contentHash))) {
    throw new Error('facts-absorb: contentHash must be a SHA-256 hex digest');
  }

  return {
    schema_version: FACTS_ABSORB_JOB_SCHEMA_VERSION,
    slug: data.slug,
    sourceId,
    sessionId,
    source: source as FactsAbsorbJobData['source'],
    notabilityFilter,
    contentHash,
  };
}

export function factsContentHash(compiledTruth: string): string {
  return createHash('sha256').update(compiledTruth).digest('hex');
}
