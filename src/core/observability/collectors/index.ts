/**
 * Collector fan-out. Each adapter owns its evidence domain; this module
 * maps registry entries to adapters without duplicating SQL ownership.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import { collectIngestionSourceEvidence } from './ingestion-source.ts';
import { collectMinionJobEvidence } from './minion-job.ts';
import { collectDreamPhaseEvidence } from './dream-phase.ts';
import { collectEmbeddingEvidence } from './embedding.ts';
import { collectRetrievalEvidence } from './retrieval.ts';
import { collectLocalRuntimeEvidence } from './local-runtime.ts';

export interface CollectAllOpts {
  engine: BrainEngine | null;
  registry: ExpectedWorkEntry[];
  config?: GBrainConfig | null;
  now?: Date;
  timeoutMs?: number;
}

export interface CollectAllResult {
  evidence: Map<string, WorkEvidence | null>;
  warnings: string[];
  partial: boolean;
}

type AdapterFn = (
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: { config?: GBrainConfig | null; now: Date },
) => Promise<Map<string, WorkEvidence | null>>;

const ADAPTERS: Record<string, AdapterFn> = {
  ingestion_source: collectIngestionSourceEvidence,
  minion_job: collectMinionJobEvidence,
  dream_phase: collectDreamPhaseEvidence,
  embedding: collectEmbeddingEvidence,
  retrieval: collectRetrievalEvidence,
  local_runtime: collectLocalRuntimeEvidence,
};

export async function collectAllEvidence(opts: CollectAllOpts): Promise<CollectAllResult> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const evidence = new Map<string, WorkEvidence | null>();
  const warnings: string[] = [];
  let partial = false;

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
      warnings.push(`collector timeout before ${adapterId}`);
      for (const e of entries) {
        evidence.set(e.key, {
          last_attempt_at: null,
          last_success_at: null,
          backlog_items: null,
          oldest_pending_age_seconds: null,
          recent_failures: null,
          force_state: 'unknown',
          force_reason: 'collector_timeout',
        });
      }
      continue;
    }

    const adapter = ADAPTERS[adapterId];
    if (!adapter) {
      for (const e of entries) {
        evidence.set(e.key, null);
      }
      warnings.push(`unknown adapter ${adapterId}`);
      continue;
    }

    try {
      const result = await withTimeout(
        adapter(entries, opts.engine, { config: opts.config, now }),
        remaining,
        adapterId,
      );
      if (result === 'timeout') {
        partial = true;
        warnings.push(`collector timeout: ${adapterId}`);
        for (const e of entries) {
          evidence.set(e.key, {
            last_attempt_at: null,
            last_success_at: null,
            backlog_items: null,
            oldest_pending_age_seconds: null,
            recent_failures: null,
            force_state: 'unknown',
            force_reason: 'collector_timeout',
          });
        }
      } else {
        for (const [k, v] of result) evidence.set(k, v);
      }
    } catch (err) {
      partial = true;
      warnings.push(`collector ${adapterId} failed: ${(err as Error).message}`);
      for (const e of entries) {
        evidence.set(e.key, {
          last_attempt_at: null,
          last_success_at: null,
          backlog_items: null,
          oldest_pending_age_seconds: null,
          recent_failures: null,
          force_state: 'unknown',
          force_reason: opts.engine ? 'evidence_unavailable' : 'db_unreachable',
        });
      }
    }
  }

  return { evidence, warnings, partial };
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  _label: string,
): Promise<T | 'timeout'> {
  if (ms <= 0) return 'timeout';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
