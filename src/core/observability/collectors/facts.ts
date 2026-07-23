/**
 * Generic fact backlog evidence using the engine-owned facts contract.
 */

import type { BrainEngine } from '../../engine.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import type { CollectorOpts } from './index.ts';

interface CountRow {
  source_id: string;
  count: number | string;
}

export async function collectFactEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  _opts: CollectorOpts,
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) return unavailable(entries, 'db_unreachable');

  const sourceIds = [...new Set(entries.map((entry) => entry.selector))];
  try {
    const rows = await engine.executeRaw<CountRow>(
      `SELECT source_id, COUNT(*)::int AS count
         FROM facts
        WHERE source_id = ANY($1::text[])
          AND consolidated_at IS NULL
          AND expired_at IS NULL
        GROUP BY source_id`,
      [sourceIds],
    );
    const counts = new Map(rows.map((row) => [row.source_id, Number(row.count)]));
    for (const entry of entries) {
      out.set(entry.key, backlogEvidence(counts.get(entry.selector) ?? 0));
    }
    return out;
  } catch {
    // Preserve the former per-source failure semantics. This fallback also
    // supports legacy/test engines that expose the engine-owned counter but
    // not the batched raw-query surface.
  }

  for (const entry of entries) {
    try {
      const backlog = typeof engine.countUnconsolidatedFacts === 'function'
        ? await engine.countUnconsolidatedFacts(entry.selector)
        : Number((await engine.executeRaw<{ count: number | string }>(
          `SELECT COUNT(*)::int AS count
             FROM facts
            WHERE source_id = $1
              AND consolidated_at IS NULL
              AND expired_at IS NULL`,
          [entry.selector],
        ))[0]?.count ?? 0);
      out.set(entry.key, backlogEvidence(backlog));
    } catch {
      out.set(entry.key, unknownEvidence('evidence_unavailable'));
    }
  }
  return out;
}

function backlogEvidence(backlog: number): WorkEvidence {
  return {
    last_attempt_at: null,
    last_success_at: null,
    backlog_items: backlog,
    oldest_pending_age_seconds: null,
    recent_failures: 0,
  };
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
