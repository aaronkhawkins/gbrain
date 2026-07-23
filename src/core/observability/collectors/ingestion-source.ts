/**
 * Source intake evidence — reuses source-health.ts, no duplicate SQL ownership.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { computeAllSourceMetrics } from '../../source-health.ts';
import { loadAllSources } from '../../sources-load.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import { sourceWorkKey } from '../expected-work.ts';
import { toIsoTimestampStrict, unavailableEvidence } from './helpers.ts';

export async function collectIngestionSourceEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  _opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const e of entries) out.set(e.key, unavailableEvidence('db_unreachable'));
    return out;
  }

  let metrics;
  try {
    const sources = await loadAllSources(engine, { includeArchived: false });
    metrics = await computeAllSourceMetrics(engine, sources, { probeContent: true });
  } catch {
    for (const e of entries) out.set(e.key, unavailableEvidence('evidence_unavailable'));
    return out;
  }

  const byId = new Map(metrics.map((m) => [m.source_id, m]));

  for (const entry of entries) {
    const m = byId.get(entry.selector);
    const m2 = m ?? [...byId.values()].find((x) => sourceWorkKey(x.source_id) === entry.key);
    if (!m2) {
      out.set(entry.key, unavailableEvidence('evidence_unavailable'));
      continue;
    }

    const lastSync = toIsoTimestampStrict(m2.last_sync_at);

    // Quiet caught-up source: lag_seconds === 0 is healthy even without wall-clock freshness.
    const forceHealthyQuiet =
      m2.lag_seconds === 0 && m2.failed_jobs_24h === 0;

    out.set(entry.key, {
      last_attempt_at: lastSync,
      last_success_at: lastSync,
      backlog_items: m2.queue_depth,
      oldest_pending_age_seconds: m2.lag_seconds,
      recent_failures: m2.failed_jobs_24h,
      ...(forceHealthyQuiet
        ? { force_state: 'healthy' as const, force_reason: 'ok' as const }
        : m2.failed_jobs_24h >= 5
          ? { force_state: 'failed' as const, force_reason: 'recent_failures' as const }
          : m2.failed_jobs_24h >= 1
            ? { force_state: 'degraded' as const, force_reason: 'recent_failures' as const }
            : {}),
    });
  }

  return out;
}
