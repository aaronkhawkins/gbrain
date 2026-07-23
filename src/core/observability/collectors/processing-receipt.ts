import type { BrainEngine } from '../../engine.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import { unavailableEvidence } from './helpers.ts';

interface ReceiptEvidenceRow {
  processor_key: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  latest_outcome: string | null;
  backlog_items: number | null;
  recent_failures: number;
}

export async function collectProcessingReceiptEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: { now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const entry of entries) out.set(entry.key, unavailableEvidence('db_unreachable'));
    return out;
  }

  const rows = await engine.executeRaw<ReceiptEvidenceRow>(
    `SELECT r.processor_key,
            MAX(p.started_at)::text AS last_attempt_at,
            MAX(p.finished_at) FILTER (WHERE p.outcome IN ('completed','skipped'))::text AS last_success_at,
            (SELECT p2.outcome FROM processing_receipts p2
              WHERE p2.processor_key = r.processor_key
              ORDER BY COALESCE(p2.finished_at, p2.started_at) DESC, p2.id DESC LIMIT 1) AS latest_outcome,
            (SELECT p3.backlog_count FROM processing_receipts p3
              WHERE p3.processor_key = r.processor_key
              ORDER BY COALESCE(p3.finished_at, p3.started_at) DESC, p3.id DESC LIMIT 1) AS backlog_items,
            COUNT(*) FILTER (
              WHERE p.outcome = 'failed' AND COALESCE(p.finished_at, p.started_at) >= $1
            )::int AS recent_failures
       FROM processing_registrations r
       LEFT JOIN processing_receipts p ON p.processor_key = r.processor_key
      WHERE r.processor_key = ANY($2)
      GROUP BY r.processor_key`,
    [
      new Date(opts.now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      entries.map((entry) => entry.selector),
    ],
  );
  const byKey = new Map(rows.map((row) => [row.processor_key, row]));

  for (const entry of entries) {
    const row = byKey.get(entry.selector);
    if (!row?.last_attempt_at) {
      out.set(entry.key, unavailableEvidence('evidence_unavailable'));
      continue;
    }
    const evidence: WorkEvidence = {
      last_attempt_at: row.last_attempt_at,
      last_success_at: row.last_success_at,
      backlog_items: row.backlog_items,
      oldest_pending_age_seconds: row.latest_outcome === 'running'
        ? Math.max(0, Math.floor((opts.now.getTime() - new Date(row.last_attempt_at).getTime()) / 1000))
        : null,
      recent_failures: row.recent_failures,
    };
    if (row.latest_outcome === 'failed') {
      evidence.force_state = 'failed';
      evidence.force_reason = 'recent_failures';
    } else if (row.latest_outcome === 'partial') {
      evidence.force_state = 'degraded';
      evidence.force_reason = 'recent_failures';
    }
    out.set(entry.key, evidence);
  }
  return out;
}
