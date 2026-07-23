/**
 * Generic fact backlog evidence using the engine-owned facts contract.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';

export async function collectFactEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  _opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) return unavailable(entries, 'db_unreachable');

  for (const entry of entries) {
    try {
      const backlog = await engine.countUnconsolidatedFacts(entry.selector);
      out.set(entry.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: backlog,
        oldest_pending_age_seconds: null,
        recent_failures: 0,
      });
    } catch {
      out.set(entry.key, unknownEvidence('evidence_unavailable'));
    }
  }
  return out;
}

function unavailable(
  entries: ExpectedWorkEntry[],
  reason: 'db_unreachable',
): Map<string, WorkEvidence | null> {
  return new Map(entries.map((entry) => [entry.key, unknownEvidence(reason)]));
}

function unknownEvidence(
  reason: 'db_unreachable' | 'evidence_unavailable',
): WorkEvidence {
  return {
    last_attempt_at: null,
    last_success_at: null,
    backlog_items: null,
    oldest_pending_age_seconds: null,
    recent_failures: null,
    force_state: 'unknown',
    force_reason: reason,
  };
}
