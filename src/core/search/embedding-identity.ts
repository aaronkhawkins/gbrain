import type { BrainEngine } from '../engine.ts';
import type { ResolvedColumn } from '../types.ts';
import { readContentChunksEmbeddingDim } from '../embedding-dim-check.ts';
import {
  buildEmbeddingSignature,
  documentPreprocessingSignature,
  parseEmbeddingSignature,
} from '../embedding-provenance.ts';

export type EmbeddingIdentityStatus =
  | 'compatible'
  | 'empty'
  | 'unselected'
  | 'incompatible'
  | 'unknown';

export interface EmbeddingIdentityDiagnostics {
  status: EmbeddingIdentityStatus;
  vectorSearchAllowed: boolean;
  desired: {
    column: string;
    model: string;
    dimensions: number;
    preprocessing: string;
    signature: string;
  };
  observed: {
    databaseModel: string | null;
    databaseDimensions: number | null;
    columnDimensions: number | null;
    columnType: 'vector' | 'halfvec' | null;
    embeddedChunks: number;
    chunkModels: string[];
    pageSignatures: string[];
    chunkerVersions: number[];
    contextualModes: string[];
    corpusGenerations: string[];
    chunksMissingModel: number;
    pagesMissingSignature: number;
  };
  disagreements: string[];
}

interface GateCacheEntry {
  expiresAt: number;
  pending: boolean;
  value: Promise<EmbeddingIdentityDiagnostics>;
}

const MAX_CACHED_IDENTITIES_PER_ENGINE = 4;
const gateCache = new WeakMap<BrainEngine, Map<string, GateCacheEntry>>();

/** Search-hot-path wrapper: coalesces concurrent PGLite reads and bounds DB work. */
export function embeddingIdentityGate(
  engine: BrainEngine,
  resolved: ResolvedColumn,
  ttlMs = 0,
): Promise<EmbeddingIdentityDiagnostics> {
  const key = `${resolved.name}:${resolved.embeddingModel}:${resolved.dimensions}`;
  const now = Date.now();
  let entries = gateCache.get(engine);
  if (!entries) {
    entries = new Map();
    gateCache.set(engine, entries);
  }
  const cached = entries.get(key);
  if (cached && (cached.pending || cached.expiresAt > now)) return cached.value;

  const value = inspectEmbeddingIdentity(engine, resolved);
  const entry: GateCacheEntry = { expiresAt: 0, pending: true, value };
  entries.set(key, entry);
  while (entries.size > MAX_CACHED_IDENTITIES_PER_ENGINE) {
    const oldestSettled = [...entries].find(([, candidate]) => !candidate.pending)?.[0];
    if (!oldestSettled) break;
    entries.delete(oldestSettled);
  }
  void value.then(
    () => {
      entry.pending = false;
      entry.expiresAt = Date.now() + ttlMs;
    },
    () => {
      if (entries?.get(key)?.value === value) entries.delete(key);
    },
  );
  return value;
}

interface ProvenanceRow {
  embedded_chunks: number | string;
  chunk_models: string[] | null;
  page_signatures: string[] | null;
  chunker_versions: Array<number | string> | null;
  contextual_modes: string[] | null;
  corpus_generations: string[] | null;
  chunks_missing_model: number | string;
  pages_missing_signature: number | string;
}

/**
 * Read-only, bounded vector-space preflight for the primary text column.
 * No model is selected and no vectors are rewritten here. The database
 * config is treated as the operator's persisted selection; runtime/file
 * overrides must agree with it before vector ranking is allowed.
 */
export async function inspectEmbeddingIdentity(
  engine: BrainEngine,
  resolved: ResolvedColumn,
): Promise<EmbeddingIdentityDiagnostics> {
  const preprocessing = documentPreprocessingSignature(resolved.embeddingModel);
  const desired = {
    column: resolved.name,
    model: resolved.embeddingModel,
    dimensions: resolved.dimensions,
    preprocessing,
    signature: buildEmbeddingSignature({
      model: resolved.embeddingModel,
      dimensions: resolved.dimensions,
      column: resolved.name,
      preprocessing,
    }),
  };
  const disagreements: string[] = [];

  if (resolved.name !== 'embedding') {
    return unknownDiagnostics(desired, ['non-primary column provenance is not yet observable']);
  }

  try {
    // Keep reads sequential. PGLite exposes one in-process connection and
    // concurrent catalog/config reads can self-queue behind a running search.
    const databaseModel = await engine.getConfig('embedding_model');
    const databaseDimensionsRaw = await engine.getConfig('embedding_dimensions');
    const column = await readContentChunksEmbeddingDim(engine);
    const rows = await engine.executeRaw<ProvenanceRow>(
        `SELECT
           COUNT(*)::int AS embedded_chunks,
           COALESCE(array_agg(DISTINCT cc.model), ARRAY[]::text[]) AS chunk_models,
           COALESCE(array_agg(DISTINCT p.embedding_signature) FILTER (WHERE p.embedding_signature IS NOT NULL), ARRAY[]::text[]) AS page_signatures,
           COALESCE(array_agg(DISTINCT p.chunker_version) FILTER (WHERE p.chunker_version IS NOT NULL), ARRAY[]::smallint[]) AS chunker_versions,
           COALESCE(array_agg(DISTINCT p.contextual_retrieval_mode) FILTER (WHERE p.contextual_retrieval_mode IS NOT NULL), ARRAY[]::text[]) AS contextual_modes,
           COALESCE(array_agg(DISTINCT p.corpus_generation) FILTER (WHERE p.corpus_generation IS NOT NULL), ARRAY[]::text[]) AS corpus_generations,
           COUNT(*) FILTER (WHERE cc.model IS NULL OR cc.model = '')::int AS chunks_missing_model,
           COUNT(DISTINCT p.id) FILTER (WHERE p.embedding_signature IS NULL OR p.embedding_signature = '')::int AS pages_missing_signature
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NOT NULL`,
      );
    const row = rows[0];
    const databaseDimensions = parsePositiveInt(databaseDimensionsRaw);
    const embeddedChunks = Number(row?.embedded_chunks ?? 0);
    const chunkModels = sortedStrings(row?.chunk_models);
    const pageSignatures = sortedStrings(row?.page_signatures);
    const chunkerVersions = [...new Set((row?.chunker_versions ?? []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    const contextualModes = sortedStrings(row?.contextual_modes);
    const corpusGenerations = sortedStrings(row?.corpus_generations);
    const chunksMissingModel = Number(row?.chunks_missing_model ?? 0);
    const pagesMissingSignature = Number(row?.pages_missing_signature ?? 0);

    if (!databaseModel || databaseDimensions === null) {
      disagreements.push('database embedding selection is incomplete');
    } else {
      if (databaseModel !== desired.model) disagreements.push('runtime model disagrees with database selection');
      if (databaseDimensions !== desired.dimensions) disagreements.push('runtime dimensions disagree with database selection');
    }
    if (!column.exists || column.dims === null) disagreements.push('active embedding column shape is unknown');
    else if (column.dims !== desired.dimensions) disagreements.push('active embedding column dimensions disagree with runtime');
    if (column.columnType !== null && column.columnType !== resolved.type) {
      disagreements.push('active embedding column storage type disagrees with runtime');
    }

    if (embeddedChunks > 0) {
      if (chunksMissingModel > 0 || chunkModels.length === 0) {
        disagreements.push('stored vector model provenance is unknown');
      }
      if (chunkModels.length > 1) disagreements.push('stored vectors contain mixed model provenance');
      if (chunkModels.some((model) => model !== desired.model)) {
        disagreements.push('stored vector model disagrees with runtime');
      }
      if (pagesMissingSignature > 0) {
        disagreements.push('stored page embedding provenance is missing');
      }
      if (pageSignatures.length > 1) disagreements.push('stored pages contain mixed embedding signatures');
      if (pageSignatures.some((signature) => parseEmbeddingSignature(signature)?.version !== 2)) {
        disagreements.push('stored page embedding signature is legacy or incomplete');
      }
      if (pageSignatures.some((signature) => signature !== desired.signature)) {
        disagreements.push('stored page embedding signature disagrees with runtime');
      }
    }

    const selected = !!databaseModel && databaseDimensions !== null;
    const status = resolveEmbeddingIdentityStatus(embeddedChunks, selected, disagreements);

    return {
      status,
      vectorSearchAllowed: status === 'compatible',
      desired,
      observed: {
        databaseModel,
        databaseDimensions,
        columnDimensions: column.dims,
        columnType: column.columnType,
        embeddedChunks,
        chunkModels,
        pageSignatures,
        chunkerVersions,
        contextualModes,
        corpusGenerations,
        chunksMissingModel,
        pagesMissingSignature,
      },
      disagreements,
    };
  } catch {
    return unknownDiagnostics(desired, ['embedding provenance could not be read']);
  }
}

function resolveEmbeddingIdentityStatus(
  embeddedChunks: number,
  selected: boolean,
  disagreements: string[],
): EmbeddingIdentityStatus {
  if (embeddedChunks === 0) return 'empty';
  if (!selected) return 'unselected';
  return disagreements.length > 0 ? 'incompatible' : 'compatible';
}

function unknownDiagnostics(
  desired: EmbeddingIdentityDiagnostics['desired'],
  disagreements: string[],
): EmbeddingIdentityDiagnostics {
  return {
    status: 'unknown',
    vectorSearchAllowed: false,
    desired,
    observed: {
      databaseModel: null,
      databaseDimensions: null,
      columnDimensions: null,
      columnType: null,
      embeddedChunks: 0,
      chunkModels: [],
      pageSignatures: [],
      chunkerVersions: [],
      contextualModes: [],
      corpusGenerations: [],
      chunksMissingModel: 0,
      pagesMissingSignature: 0,
    },
    disagreements,
  };
}

function parsePositiveInt(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sortedStrings(values: string[] | null | undefined): string[] {
  return [...new Set((values ?? []).filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
}
