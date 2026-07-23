import type { BrainEngine } from '../../engine.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import type { ProcessingOutcome } from '../../processing-receipts.ts';
import { unavailableEvidence, unavailableEvidenceMap } from './helpers.ts';

interface ReceiptEvidenceRow {
  processor_key: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  latest_outcome: ProcessingOutcome | null;
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
    return unavailableEvidenceMap(entries, 'db_unreachable');
  }

  const rows = await engine.executeRaw<ReceiptEvidenceRow>(
    `SELECT r.processor_key,
            latest.started_at::text AS last_attempt_at,
            success.finished_at::text AS last_success_at,
            latest.outcome AS latest_outcome,
            latest.backlog_count AS backlog_items,
            COALESCE(failures.recent_failures, 0)::int AS recent_failures
       FROM processing_registrations r
       LEFT JOIN LATERAL (
         SELECT p2.started_at, p2.outcome, p2.backlog_count
          FROM processing_receipts p2
          WHERE p2.processor_key = r.processor_key
            AND p2.processor_version = r.processor_version
          ORDER BY p2.started_at DESC, p2.id DESC
          LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT p3.finished_at
           FROM processing_receipts p3
          WHERE p3.processor_key = r.processor_key
            AND p3.processor_version = r.processor_version
            AND p3.outcome IN ('completed','skipped')
          ORDER BY p3.finished_at DESC, p3.id DESC
          LIMIT 1
       ) success ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS recent_failures
           FROM (
             SELECT p4.finished_at
               FROM processing_receipts p4
              WHERE p4.processor_key = r.processor_key
                AND p4.processor_version = r.processor_version
                AND p4.outcome = 'failed'
             UNION ALL
             SELECT a.finished_at
               FROM processing_receipt_attempts a
               JOIN processing_receipts p5 ON p5.id = a.receipt_id
              WHERE p5.processor_key = r.processor_key
                AND p5.processor_version = r.processor_version
                AND a.outcome = 'failed'
           ) failed_attempts
          WHERE failed_attempts.finished_at >= $1
       ) failures ON TRUE
      WHERE r.processor_key = ANY($2)
      ORDER BY r.processor_key`,
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
