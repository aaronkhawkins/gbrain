/**
 * Collector fan-out. Each adapter owns its evidence domain; this module
 * maps registry entries to adapters without duplicating SQL ownership.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { computeAllSourceMetrics, type SourceMetrics } from '../../source-health.ts';
import { loadAllSources } from '../../sources-load.ts';
import type {
  EvidenceAdapterId,
  ExpectedWorkEntry,
  ObservabilityWarningCode,
  WorkEvidence,
} from '../types.ts';
import { collectIngestionSourceEvidence } from './ingestion-source.ts';
import { collectMinionJobEvidence } from './minion-job.ts';
import { collectDreamPhaseEvidence } from './dream-phase.ts';
import { collectEmbeddingEvidence } from './embedding.ts';
import { collectRetrievalEvidence } from './retrieval.ts';
import { collectLocalRuntimeEvidence } from './local-runtime.ts';
import { collectFactEvidence } from './facts.ts';
import { collectLinkEvidence } from './links.ts';
import { collectExtractRollupEvidence } from './extract-rollup.ts';
import { collectDiscoveryEvidence } from './discovery.ts';
import { collectProcessingReceiptEvidence } from './processing-receipt.ts';
import {
  sourceIdsForScope,
  unavailableEvidence,
  unavailableEvidenceMap,
} from './helpers.ts';

export interface CollectAllOpts {
  engine: BrainEngine | null;
  registry: ExpectedWorkEntry[];
  config?: GBrainConfig | null;
  now?: Date;
  timeoutMs?: number;
  /** Canonical source grant for remote snapshots; undefined means whole brain. */
  sourceId?: string;
  sourceIds?: string[];
  /** Test/extension seam; production uses the fixed adapter registry. */
  adapters?: Partial<Record<EvidenceAdapterId, AdapterFn>>;
  /** Raw details stay local and never enter snapshots. */
  onCollectorError?: (adapterId: string, error: unknown) => void;
}

export interface CollectAllResult {
  evidence: Map<string, WorkEvidence | null>;
  warnings: ObservabilityWarningCode[];
  partial: boolean;
}

export interface CollectorContext {
  /**
   * One lazy source-health read shared by every adapter in this snapshot.
   * Observer collection uses the durable database content watermark. Live Git
   * probes are synchronous and belong only on interactive local commands.
   */
  getSourceMetrics: () => Promise<SourceMetrics[]>;
}

export interface CollectorOpts {
  config?: GBrainConfig | null;
  now: Date;
  context?: CollectorContext;
  sourceId?: string;
  sourceIds?: string[];
  /** Adapter deadline; async probes should stop promptly when aborted. */
  signal?: AbortSignal;
}

export type AdapterFn = (
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: CollectorOpts,
) => Promise<Map<string, WorkEvidence | null>>;

const ADAPTERS: Record<string, AdapterFn> = {
  ingestion_source: collectIngestionSourceEvidence,
  minion_job: collectMinionJobEvidence,
  dream_phase: collectDreamPhaseEvidence,
  embedding: collectEmbeddingEvidence,
  retrieval: collectRetrievalEvidence,
  local_runtime: collectLocalRuntimeEvidence,
  facts: collectFactEvidence,
  links: collectLinkEvidence,
  extract_rollup: collectExtractRollupEvidence,
  processing_receipt: collectProcessingReceiptEvidence,
  discovery: collectDiscoveryEvidence,
};

export async function collectAllEvidence(opts: CollectAllOpts): Promise<CollectAllResult> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const evidence = new Map<string, WorkEvidence | null>();
  const warnings: ObservabilityWarningCode[] = [];
  let partial = false;
  let sourceMetrics: Promise<SourceMetrics[]> | undefined;
  const scopedSourceIds = sourceIdsForScope(opts);
  const contextFor = (engine: BrainEngine | null): CollectorContext => ({
    getSourceMetrics: () => {
      if (!sourceMetrics) {
        sourceMetrics = (async () => {
          if (!engine) throw new Error('database unavailable');
          const sources = await loadAllSources(engine, {
            includeArchived: false,
            sourceIds: scopedSourceIds,
          });
          return computeAllSourceMetrics(engine, sources, {
            probeContent: false,
            sourceIds: scopedSourceIds,
          });
        })();
      }
      return sourceMetrics;
    },
  });

  const warn = (code: ObservabilityWarningCode): void => {
    if (!warnings.includes(code)) warnings.push(code);
  };

  // Group by adapter.
  const byAdapter = new Map<string, ExpectedWorkEntry[]>();
  for (const entry of opts.registry) {
    if (entry.evidence_adapter === 'none') {
      evidence.set(entry.key, null);
      continue;
    }
    const list = byAdapter.get(entry.evidence_adapter) ?? [];
    list.push(entry);
    byAdapter.set(entry.evidence_adapter, list);
  }

  const deadline = Date.now() + timeoutMs;

  for (const [adapterId, entries] of byAdapter) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      partial = true;
      warn('collector_timeout');
      for (const [key, value] of unavailableEvidenceMap(entries, 'collector_timeout')) {
        evidence.set(key, value);
      }
      continue;
    }

    const adapter =
      opts.adapters?.[adapterId as EvidenceAdapterId] ??
      ADAPTERS[adapterId];
    if (!adapter) {
      for (const e of entries) {
        evidence.set(e.key, null);
      }
      warn('collector_unknown_adapter');
      continue;
    }

    try {
      const controller = new AbortController();
      const adapterEngine = opts.engine
        ? withAbortSignal(opts.engine, controller.signal)
        : null;
      const result = await withTimeout(
        adapter(entries, adapterEngine, {
          config: opts.config,
          now,
          context: contextFor(adapterEngine),
          signal: controller.signal,
          sourceId: opts.sourceId,
          sourceIds: opts.sourceIds,
        }),
        remaining,
        controller,
      );
      if (result === 'timeout') {
        partial = true;
        warn('collector_timeout');
        for (const [key, value] of unavailableEvidenceMap(entries, 'collector_timeout')) {
          evidence.set(key, value);
        }
      } else {
        for (const [k, v] of result) evidence.set(k, v);
      }
    } catch (err) {
      partial = true;
      opts.onCollectorError?.(adapterId, err);
      warn('collector_failed');
      for (const e of entries) {
        evidence.set(
          e.key,
          unavailableEvidence(opts.engine ? 'evidence_unavailable' : 'db_unreachable'),
        );
      }
    }
  }

  return { evidence, warnings, partial };
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T | 'timeout'> {
  if (ms <= 0) {
    controller.abort();
    return 'timeout';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
          controller.abort();
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Preserve the full engine API while enforcing the collector deadline on
 * every raw query issued by an adapter or a helper it calls.
 */
function withAbortSignal(engine: BrainEngine, signal: AbortSignal): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_target, property) {
      if (property === 'executeRaw') {
        return <T = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<T[]> => engine.executeRaw<T>(sql, params, { signal });
      }
      const value = Reflect.get(engine, property, engine);
      return typeof value === 'function' ? value.bind(engine) : value;
    },
  });
}
