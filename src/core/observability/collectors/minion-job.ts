/**
 * Recurring Minion job evidence from minion_jobs — uses existing table,
 * no observer-specific schema.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';

interface JobAggRow {
  name: string;
  last_attempt: string | Date | null;
  last_success: string | Date | null;
  recent_failures: number | string | null;
  backlog: number | string | null;
  dead: number | string | null;
  oldest_waiting_age_seconds: number | string | null;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function collectMinionJobEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  _opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const e of entries) {
      out.set(e.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: null,
        force_state: 'unknown',
        force_reason: 'db_unreachable',
      });
    }
    return out;
  }

  const names = [...new Set(entries.map((e) => e.selector))];
  if (names.length === 0) return out;

  // One batched query for all registered job names.
  let rows: JobAggRow[] = [];
  try {
    rows = await engine.executeRaw<JobAggRow>(
      `SELECT
         name,
         MAX(COALESCE(finished_at, started_at, created_at)) AS last_attempt,
         MAX(finished_at) FILTER (WHERE status = 'completed') AS last_success,
         COUNT(*) FILTER (
           WHERE status IN ('failed', 'dead')
             AND COALESCE(finished_at, updated_at, created_at) > NOW() - INTERVAL '24 hours'
         ) AS recent_failures,
         COUNT(*) FILTER (
           WHERE status IN ('waiting', 'active', 'delayed', 'waiting-children')
         ) AS backlog,
         COUNT(*) FILTER (WHERE status = 'dead') AS dead,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (
           WHERE status IN ('waiting', 'delayed', 'waiting-children')
         ))) AS oldest_waiting_age_seconds
       FROM minion_jobs
       WHERE name = ANY($1::text[])
       GROUP BY name`,
      [names],
    );
  } catch {
    // PGLite may not support FILTER the same way — fall back to simpler query.
    try {
      for (const name of names) {
        const simple = await engine.executeRaw<{
          last_attempt: string | Date | null;
          last_success: string | Date | null;
          recent_failures: number | string | null;
          backlog: number | string | null;
          dead: number | string | null;
        }>(
          `SELECT
             (SELECT MAX(COALESCE(finished_at, started_at, created_at)) FROM minion_jobs WHERE name = $1) AS last_attempt,
             (SELECT MAX(finished_at) FROM minion_jobs WHERE name = $1 AND status = 'completed') AS last_success,
             (SELECT COUNT(*) FROM minion_jobs WHERE name = $1 AND status IN ('failed','dead')
                AND COALESCE(finished_at, updated_at, created_at) > NOW() - INTERVAL '24 hours') AS recent_failures,
             (SELECT COUNT(*) FROM minion_jobs WHERE name = $1 AND status IN ('waiting','active','delayed','waiting-children')) AS backlog,
             (SELECT COUNT(*) FROM minion_jobs WHERE name = $1 AND status = 'dead') AS dead`,
          [name],
        );
        const r = simple[0];
        if (r) {
          rows.push({
            name,
            last_attempt: r.last_attempt,
            last_success: r.last_success,
            recent_failures: r.recent_failures,
            backlog: r.backlog,
            dead: r.dead,
            oldest_waiting_age_seconds: null,
          });
        }
      }
    } catch {
      for (const e of entries) {
        out.set(e.key, {
          last_attempt_at: null,
          last_success_at: null,
          backlog_items: null,
          oldest_pending_age_seconds: null,
          recent_failures: null,
          force_state: 'unknown',
          force_reason: 'evidence_unavailable',
        });
      }
      return out;
    }
  }

  const byName = new Map(rows.map((r) => [r.name, r]));

  for (const entry of entries) {
    const r = byName.get(entry.selector);
    if (!r) {
      // No rows ever for this job name — unknown until first run (not healthy).
      out.set(entry.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: 0,
        oldest_pending_age_seconds: null,
        recent_failures: 0,
        force_state: 'unknown',
        force_reason: 'evidence_unavailable',
      });
      continue;
    }

    const dead = num(r.dead);
    const recentFailures = num(r.recent_failures);
    const backlog = num(r.backlog);

    out.set(entry.key, {
      last_attempt_at: iso(r.last_attempt),
      last_success_at: iso(r.last_success),
      backlog_items: backlog,
      oldest_pending_age_seconds: r.oldest_waiting_age_seconds == null
        ? null
        : num(r.oldest_waiting_age_seconds),
      recent_failures: recentFailures,
      ...(dead > 0
        ? { force_state: 'failed' as const, force_reason: 'dead' as const }
        : backlog > 0 && num(r.oldest_waiting_age_seconds) > 3600
          ? { force_state: 'degraded' as const, force_reason: 'stalled' as const }
          : {}),
    });
  }

  return out;
}
