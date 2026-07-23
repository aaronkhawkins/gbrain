/**
 * Dream/cycle phase evidence with source/global isolation.
 *
 * Source-scoped entries only consume matching autopilot-cycle rows; global
 * phases only consume autopilot-global-maintenance. Skips are classified so a
 * benign no-op is a success while missing prerequisites never become green.
 */

import type { BrainEngine } from '../../engine.ts';
import { PHASE_SCOPE, type CyclePhase } from '../../cycle.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import type { CollectorOpts } from './index.ts';
import {
  newestIso,
  parseJsonRecord,
  sourceIdsForScope,
  toIsoTimestamp,
  unavailableEvidence,
} from './helpers.ts';

interface CycleJobRow {
  finished_at: string | Date | null;
  started_at: string | Date | null;
  status: string;
  result: unknown;
  data: unknown;
  name: string;
}

interface PhaseOutcome {
  status: string;
  finished_at: string | null;
  reason: string | null;
}

interface NormalizedCycleJob {
  status: string;
  event_at: string | null;
  source_id: string | null;
  name: string;
  outcomes: Map<string, PhaseOutcome>;
  skip_reason: string | null;
}

type SkipClass = 'success' | 'deferred' | 'failure';

const BENIGN_SKIP_REASONS = new Set([
  'no_work',
  'no_atoms',
  'no_groups_above_threshold',
  'already_fresh',
  'up_to_date',
  'no_changes',
  'nothing_to_do',
  'not_due',
  'insufficient_evidence',
  'cooldown_active',
]);

const DEFERRED_SKIP_REASONS = new Set([
  'cycle_already_running',
  'lock_busy',
  'source_in_cooldown',
  'disabled',
  'not_in_active_pack',
  'no_dry_run_support',
  'dry_run',
]);

function nestedReason(record: Record<string, unknown>): string | null {
  if (typeof record.reason === 'string') return record.reason;
  const details = parseJsonRecord(record.details);
  if (typeof details?.reason === 'string') return details.reason;
  return typeof details?.syncStatus === 'string' ? details.syncStatus : null;
}

function parseCycleResult(result: unknown): {
  outcomes: Map<string, PhaseOutcome>;
  skipReason: string | null;
} {
  const out = new Map<string, PhaseOutcome>();
  const root = parseJsonRecord(result);
  if (!root) return { outcomes: out, skipReason: null };
  const report = parseJsonRecord(root.report) ?? root;
  if (Array.isArray(report.phases)) {
    for (const value of report.phases) {
      const record = parseJsonRecord(value);
      if (!record) continue;
      const name = typeof record.phase === 'string'
        ? record.phase
        : typeof record.name === 'string'
          ? record.name
          : null;
      if (!name) continue;
      out.set(name, {
        status: typeof record.status === 'string' ? record.status : 'unknown',
        finished_at: typeof record.finished_at === 'string' ? record.finished_at : null,
        reason: nestedReason(record),
      });
    }
  }
  const nestedReport = parseJsonRecord(root.report);
  const skipReason = root.status === 'skipped'
    ? nestedReason(nestedReport ?? root)
    : nestedReport?.status === 'skipped'
      ? nestedReason(nestedReport)
      : null;
  return { outcomes: out, skipReason };
}

function jobSourceId(data: unknown): string | null {
  const record = parseJsonRecord(data);
  const source = record?.source_id ?? record?.sourceId;
  return typeof source === 'string' ? source : null;
}

function scopeKey(name: string, sourceId: string | null): string {
  return `${name}\0${sourceId ?? '\0global'}`;
}

function entryScopeKey(entry: ExpectedWorkEntry): string {
  if (entry.scope?.type === 'source') {
    return scopeKey('autopilot-cycle', entry.scope.source_id);
  }
  const phaseScope = PHASE_SCOPE[entry.selector as CyclePhase] ?? 'global';
  if (phaseScope === 'global') return scopeKey('autopilot-global-maintenance', null);
  return scopeKey('autopilot-cycle', null);
}

export function classifyDreamSkipReason(reason: string | null): SkipClass {
  if (reason && BENIGN_SKIP_REASONS.has(reason)) return 'success';
  if (reason && DEFERRED_SKIP_REASONS.has(reason)) return 'deferred';
  return 'failure';
}

function outcomeClass(outcome: PhaseOutcome): SkipClass {
  // A warning means the scheduled phase executed and surfaced a content or
  // maintenance concern. That concern belongs to its dedicated health check;
  // it is still successful cadence evidence.
  if (['ok', 'success', 'completed', 'warn'].includes(outcome.status)) return 'success';
  if (outcome.status === 'skipped') return classifyDreamSkipReason(outcome.reason);
  return 'failure';
}

export async function collectDreamPhaseEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: CollectorOpts,
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const entry of entries) out.set(entry.key, unavailableEvidence('db_unreachable'));
    return out;
  }

  let rows: CycleJobRow[];
  try {
    const sourceIds = sourceIdsForScope(opts);
    rows = await engine.executeRaw<CycleJobRow>(
      `SELECT finished_at, started_at, status, result, data, name
       FROM minion_jobs
       WHERE name IN ('autopilot-cycle', 'autopilot-global-maintenance')
         ${sourceIds
           ? `AND COALESCE(data->>'source_id', data->>'sourceId') = ANY($1::text[])`
           : ''}
         AND status IN ('completed', 'failed', 'dead')
       ORDER BY COALESCE(finished_at, started_at) DESC NULLS LAST
       LIMIT 100`,
      sourceIds ? [sourceIds] : undefined,
    );
  } catch {
    for (const entry of entries) out.set(entry.key, unavailableEvidence('evidence_unavailable'));
    return out;
  }

  const rowsByScope = new Map<string, NormalizedCycleJob[]>();
  for (const row of rows) {
    const parsed = parseCycleResult(row.result);
    const normalized: NormalizedCycleJob = {
      status: row.status,
      event_at: toIsoTimestamp(row.finished_at) ?? toIsoTimestamp(row.started_at),
      source_id: jobSourceId(row.data),
      name: row.name,
      outcomes: parsed.outcomes,
      skip_reason: parsed.skipReason,
    };
    const key = scopeKey(normalized.name, normalized.source_id);
    const scoped = rowsByScope.get(key) ?? [];
    scoped.push(normalized);
    rowsByScope.set(key, scoped);
  }

  for (const entry of entries) {
    const attempts: string[] = [];
    const successes: string[] = [];
    const failures: string[] = [];
    let deferredAttempt = false;

    for (const row of rowsByScope.get(entryScopeKey(entry)) ?? []) {
      const timestamp = row.event_at;
      if (!timestamp) continue;

      const outcome = row.outcomes.get(entry.selector);
      if (outcome) {
        const outcomeTimestamp = outcome.finished_at ?? timestamp;
        attempts.push(outcomeTimestamp);
        const classification = outcomeClass(outcome);
        if (classification === 'success') successes.push(outcomeTimestamp);
        else if (classification === 'failure') failures.push(outcomeTimestamp);
        else deferredAttempt = true;
        continue;
      }

      const skipReason = row.skip_reason;
      if (skipReason) {
        attempts.push(timestamp);
        const classification = classifyDreamSkipReason(skipReason);
        if (classification === 'success') successes.push(timestamp);
        else if (classification === 'failure') failures.push(timestamp);
        else deferredAttempt = true;
        continue;
      }

      if (row.status === 'failed' || row.status === 'dead') {
        attempts.push(timestamp);
        failures.push(timestamp);
        continue;
      }

      // Historical results without phase detail are weak success evidence for
      // core phases only. Pack/opt-in phases remain unknown (R25).
      if (row.outcomes.size === 0 && ['sync', 'extract', 'extract_facts', 'embed', 'orphans'].includes(entry.selector)) {
        attempts.push(timestamp);
        successes.push(timestamp);
      }
    }

    const lastAttempt = newestIso(attempts);
    const lastSuccess = newestIso(successes);
    const successMs = lastSuccess ? new Date(lastSuccess).getTime() : Number.NEGATIVE_INFINITY;
    const recentCutoff = opts.now.getTime() - 24 * 60 * 60 * 1000;
    const unsupersededFailures = failures.filter((timestamp) => {
      const time = new Date(timestamp).getTime();
      return time > successMs && time >= recentCutoff;
    });

    if (!lastAttempt && !lastSuccess) {
      out.set(entry.key, unavailableEvidence('evidence_unavailable'));
      continue;
    }

    out.set(entry.key, {
      last_attempt_at: lastAttempt,
      last_success_at: lastSuccess,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: unsupersededFailures.length,
      ...(unsupersededFailures.length > 0 && !lastSuccess
        ? { force_state: 'failed' as const, force_reason: 'missed_cadence' as const }
        : unsupersededFailures.length > 0
          ? { force_state: 'degraded' as const, force_reason: 'recent_failures' as const }
          : deferredAttempt && !lastSuccess
            ? { force_state: 'unknown' as const, force_reason: 'evidence_unavailable' as const }
            : {}),
    });
  }

  return out;
}
