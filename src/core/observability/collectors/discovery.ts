import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';

export async function collectDiscoveryEvidence(
  entries: ExpectedWorkEntry[],
  _engine: BrainEngine | null,
  _opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  return new Map(entries.map((entry) => [entry.key, {
    last_attempt_at: null,
    last_success_at: null,
    backlog_items: null,
    oldest_pending_age_seconds: null,
    recent_failures: null,
    force_state: 'unknown' as const,
    force_reason: 'evidence_unavailable' as const,
  }]));
}
