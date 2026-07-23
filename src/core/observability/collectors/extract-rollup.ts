/**
 * Generic extraction/content-processor evidence over extract_rollup_7d.
 *
 * The declaration supplies the existing durable rollup kind. This adapter
 * does not introduce a second processor receipt contract.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';

interface ExtractRollupRow {
  kind: string;
  source_id: string;
  last_attempt: string | Date | null;
  last_success: string | Date | null;
  failures: number | string | null;
}

export async function collectExtractRollupEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  _opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const entry of entries) out.set(entry.key, unknownEvidence('db_unreachable'));
    return out;
  }

  const selectors = [...new Set(entries.map((entry) => entry.selector))];
  try {
    const rows = await engine.executeRaw<ExtractRollupRow>(
      `SELECT
         kind,
         source_id,
         MAX(updated_at) AS last_attempt,
         MAX(updated_at) FILTER (WHERE round_completed_count > 0) AS last_success,
         SUM(halt_count + eval_fail_count + rollup_write_failures) AS failures
       FROM extract_rollup_7d
       WHERE kind = ANY($1::text[])
         AND day >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY kind, source_id`,
      [selectors],
    );
    for (const entry of entries) {
      const row = rows.find((candidate) =>
        candidate.kind === entry.selector &&
        (entry.scope?.type !== 'source' || candidate.source_id === entry.scope.source_id));
      if (!row) {
        out.set(entry.key, unknownEvidence('evidence_unavailable'));
        continue;
      }
      const failures = finiteNumber(row.failures);
      out.set(entry.key, {
        last_attempt_at: iso(row.last_attempt),
        last_success_at: iso(row.last_success),
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: failures,
        ...(failures > 0
          ? { force_state: 'degraded' as const, force_reason: 'recent_failures' as const }
          : {}),
      });
    }
  } catch {
    for (const entry of entries) out.set(entry.key, unknownEvidence('evidence_unavailable'));
  }
  return out;
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function finiteNumber(value: number | string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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
