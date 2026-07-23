/**
 * Recurring Minion evidence from minion_jobs.
 *
 * Terminal evidence is bounded to the newest attempts per name. Current
 * backlog is queried independently so old history is never scanned and a
 * successful retry supersedes an older dead attempt.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import {
  newestIso,
  parseJsonRecord,
  toIsoTimestamp,
  unavailableEvidence,
} from './helpers.ts';

export const MINION_ATTEMPT_HISTORY_LIMIT = 100;

interface JobEvidenceRow {
  name: string;
  status: string;
  created_at: string | Date | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  updated_at: string | Date | null;
  data: unknown;
}

interface BacklogRow {
  name: string;
  data: unknown;
  status: string;
  created_at: string | Date | null;
}

function eventIso(row: JobEvidenceRow): string | null {
  return toIsoTimestamp(row.finished_at) ??
    toIsoTimestamp(row.started_at) ??
    toIsoTimestamp(row.updated_at) ??
    toIsoTimestamp(row.created_at);
}

function jobSourceId(data: unknown): string | null {
  const record = parseJsonRecord(data);
  const source = record?.source_id ?? record?.sourceId;
  return typeof source === 'string' ? source : null;
}

function matchesEntry(
  row: Pick<JobEvidenceRow, 'name' | 'data'>,
  entry: ExpectedWorkEntry,
): boolean {
  if (row.name !== entry.selector) return false;
  if (entry.scope?.type === 'source') return jobSourceId(row.data) === entry.scope.source_id;
  // Explicit global registrations must not inherit a source-scoped success.
  return jobSourceId(row.data) === null;
}

export async function collectMinionJobEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const entry of entries) {
      out.set(
        entry.key,
        unavailableEvidence('db_unreachable', { recent_failures: 0 }),
      );
    }
    return out;
  }

  const names = [...new Set(entries.map((entry) => entry.selector))];
  if (names.length === 0) return out;

  let attempts: JobEvidenceRow[];
  let backlogRows: BacklogRow[];
  try {
    attempts = await engine.executeRaw<JobEvidenceRow>(
      `WITH requested_names(name) AS (
         SELECT UNNEST($1::text[])
       )
       SELECT recent.name, recent.status, recent.created_at, recent.started_at,
              recent.finished_at, recent.updated_at, recent.data
       FROM requested_names requested
       CROSS JOIN LATERAL (
         SELECT name, status, created_at, started_at, finished_at, updated_at, data
         FROM minion_jobs
         WHERE name = requested.name
           AND status IN ('completed', 'failed', 'dead', 'cancelled')
         ORDER BY COALESCE(finished_at, started_at, updated_at, created_at) DESC, id DESC
         LIMIT ${MINION_ATTEMPT_HISTORY_LIMIT}
       ) recent`,
      [names],
    );
    backlogRows = await engine.executeRaw<BacklogRow>(
      `SELECT name, data, status, created_at
       FROM minion_jobs
       WHERE name = ANY($1::text[])
         AND status IN ('waiting', 'active', 'delayed', 'waiting-children', 'paused')`,
      [names],
    );
  } catch {
    // Engine parity fallback: bounded per-name reads avoid FILTER/window
    // dependencies on older embedded Postgres builds.
    try {
      attempts = [];
      backlogRows = [];
      for (const name of names) {
        attempts.push(...await engine.executeRaw<JobEvidenceRow>(
          `SELECT name, status, created_at, started_at, finished_at, updated_at, data
           FROM minion_jobs
           WHERE name = $1
             AND status IN ('completed', 'failed', 'dead', 'cancelled')
           ORDER BY COALESCE(finished_at, started_at, updated_at, created_at) DESC, id DESC
           LIMIT ${MINION_ATTEMPT_HISTORY_LIMIT}`,
          [name],
        ));
        backlogRows.push(...await engine.executeRaw<BacklogRow>(
          `SELECT name, data, status, created_at
           FROM minion_jobs
           WHERE name = $1
             AND status IN ('waiting', 'active', 'delayed', 'waiting-children', 'paused')`,
          [name],
        ));
      }
    } catch {
      for (const entry of entries) {
        out.set(
          entry.key,
          unavailableEvidence('evidence_unavailable', { recent_failures: 0 }),
        );
      }
      return out;
    }
  }

  for (const entry of entries) {
    const scopedAttempts = attempts.filter((row) => matchesEntry(row, entry));
    const scopedBacklog = backlogRows.filter((row) =>
      ['waiting', 'active', 'delayed', 'waiting-children', 'paused'].includes(row.status) &&
      matchesEntry(row as JobEvidenceRow, entry));
    const lastAttempt = newestIso(scopedAttempts.map(eventIso));
    const successful = scopedAttempts.filter((row) => row.status === 'completed');
    const lastSuccess = newestIso(successful.map(eventIso));
    const successMs = lastSuccess ? new Date(lastSuccess).getTime() : Number.NEGATIVE_INFINITY;
    const failureCutoffMs = opts.now.getTime() - 24 * 60 * 60 * 1000;
    const unsupersededFailures = scopedAttempts.filter((row) => {
      if (!['failed', 'dead'].includes(row.status)) return false;
      const timestamp = eventIso(row);
      if (!timestamp) return false;
      const time = new Date(timestamp).getTime();
      return time > successMs && time >= failureCutoffMs;
    });
    const unsupersededDead = unsupersededFailures.some((row) => row.status === 'dead');
    const oldestPendingMs = scopedBacklog.reduce<number | null>((oldest, row) => {
      const timestamp = toIsoTimestamp(row.created_at);
      if (!timestamp) return oldest;
      const value = new Date(timestamp).getTime();
      return oldest === null || value < oldest ? value : oldest;
    }, null);
    const oldestPendingAge = oldestPendingMs === null
      ? null
      : Math.max(0, Math.floor((opts.now.getTime() - oldestPendingMs) / 1000));

    if (scopedAttempts.length === 0 && scopedBacklog.length === 0) {
      out.set(
        entry.key,
        unavailableEvidence('evidence_unavailable', {
          backlog_items: 0,
          recent_failures: 0,
        }),
      );
      continue;
    }

    out.set(entry.key, {
      last_attempt_at: lastAttempt,
      last_success_at: lastSuccess,
      backlog_items: scopedBacklog.length,
      oldest_pending_age_seconds: oldestPendingAge,
      recent_failures: unsupersededFailures.length,
      ...(unsupersededDead
        ? { force_state: 'failed' as const, force_reason: 'dead' as const }
        : scopedBacklog.length > 0 && (oldestPendingAge ?? 0) > 3600
          ? { force_state: 'degraded' as const, force_reason: 'stalled' as const }
          : unsupersededFailures.length > 0
            ? { force_state: 'degraded' as const, force_reason: 'recent_failures' as const }
            : {}),
    });
  }

  return out;
}
