/**
 * Embedding coverage evidence — reuses source-health aggregate coverage.
 */

import type { BrainEngine } from '../../engine.ts';
import { computeAllSourceMetrics } from '../../source-health.ts';
import { loadAllSources } from '../../sources-load.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import type { CollectorOpts } from './index.ts';
import { sourceIdsForScope, unavailableEvidence } from './helpers.ts';

export async function collectEmbeddingEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: CollectorOpts,
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();

  if (opts.config?.embedding_disabled === true) {
    for (const e of entries) {
      out.set(e.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: null,
        force_state: 'disabled',
        force_reason: 'embedding_disabled',
      });
    }
    return out;
  }

  if (!engine) {
    for (const e of entries) out.set(e.key, unavailableEvidence('db_unreachable'));
    return out;
  }

  try {
    const sourceIds = sourceIdsForScope(opts);
    const metrics = opts.context
      ? await opts.context.getSourceMetrics()
      : await computeAllSourceMetrics(
        engine,
        await loadAllSources(engine, { includeArchived: false, sourceIds }),
        { probeContent: false, sourceIds },
      );
    let totalChunks = 0;
    let embedded = 0;
    let backfillQueued = 0;
    let failed = 0;
    for (const m of metrics) {
      totalChunks += m.total_chunks;
      embedded += m.embedded_chunks;
      backfillQueued += m.backfill_queued + m.backfill_active;
      failed += m.failed_jobs_24h;
    }
    const unembedded = Math.max(0, totalChunks - embedded);
    const nowIso = opts.now.toISOString();

    for (const e of entries) {
      out.set(e.key, {
        last_attempt_at: nowIso,
        last_success_at: unembedded === 0 ? nowIso : null,
        backlog_items: unembedded + backfillQueued,
        oldest_pending_age_seconds: null,
        recent_failures: failed,
        ...(unembedded === 0 && backfillQueued === 0
          ? { force_state: 'healthy' as const, force_reason: 'ok' as const }
          : {}),
      });
    }
  } catch {
    for (const e of entries) out.set(e.key, unavailableEvidence('evidence_unavailable'));
  }

  return out;
}
