/**
 * Dream / cycle phase evidence.
 *
 * Phase-aware: a completed autopilot-cycle job does not mark every phase
 * healthy. We look for phase outcomes inside job results when present, and
 * fall back to last successful cycle completion for core always-on phases
 * only when the result payload lacks per-phase detail.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';

interface CycleJobRow {
  finished_at: string | Date | null;
  started_at: string | Date | null;
  status: string;
  result: unknown;
  name: string;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; }
  }
  if (typeof v === 'object') return v as Record<string, unknown>;
  return null;
}

/**
 * Extract per-phase status from a cycle job result payload.
 * Shape varies: { report: { phases: [{ phase, status }] } } or { phases: [...] }.
 */
function phaseOutcomes(result: unknown): Map<string, { status: string; finished_at?: string | null }> {
  const out = new Map<string, { status: string; finished_at?: string | null }>();
  const root = asRecord(result);
  if (!root) return out;
  const report = asRecord(root.report) ?? root;
  const phases = report.phases;
  if (!Array.isArray(phases)) return out;
  for (const p of phases) {
    const rec = asRecord(p);
    if (!rec) continue;
    const name = typeof rec.phase === 'string' ? rec.phase
      : typeof rec.name === 'string' ? rec.name
        : null;
    if (!name) continue;
    const status = typeof rec.status === 'string' ? rec.status : 'unknown';
    out.set(name, {
      status,
      finished_at: typeof rec.finished_at === 'string' ? rec.finished_at : null,
    });
  }
  return out;
}

export async function collectDreamPhaseEvidence(
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

  let rows: CycleJobRow[] = [];
  try {
    rows = await engine.executeRaw<CycleJobRow>(
      `SELECT finished_at, started_at, status, result, name
         FROM minion_jobs
        WHERE name IN ('autopilot-cycle', 'autopilot-global-maintenance')
          AND status IN ('completed', 'failed', 'dead')
        ORDER BY COALESCE(finished_at, started_at) DESC NULLS LAST
        LIMIT 20`,
    );
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

  // Build last attempt/success per phase from result payloads.
  const lastAttempt = new Map<string, string>();
  const lastSuccess = new Map<string, string>();
  const recentFails = new Map<string, number>();
  let anyCycleSuccess: string | null = null;
  let anyCycleAttempt: string | null = null;

  for (const row of rows) {
    const finished = iso(row.finished_at) ?? iso(row.started_at);
    if (finished) {
      if (!anyCycleAttempt || finished > anyCycleAttempt) anyCycleAttempt = finished;
      if (row.status === 'completed' && (!anyCycleSuccess || finished > anyCycleSuccess)) {
        anyCycleSuccess = finished;
      }
    }

    const outcomes = phaseOutcomes(row.result);
    if (outcomes.size === 0) continue;

    for (const [phase, outcome] of outcomes) {
      const ts = outcome.finished_at ?? finished;
      if (ts) {
        const prev = lastAttempt.get(phase);
        if (!prev || ts > prev) lastAttempt.set(phase, ts);
      }
      const ok = outcome.status === 'ok' || outcome.status === 'success' || outcome.status === 'completed' || outcome.status === 'skipped';
      if (ok && ts) {
        const prev = lastSuccess.get(phase);
        if (!prev || ts > prev) lastSuccess.set(phase, ts);
      } else if (!ok) {
        recentFails.set(phase, (recentFails.get(phase) ?? 0) + 1);
      }
    }
  }

  for (const entry of entries) {
    const phase = entry.selector;
    const attempt = lastAttempt.get(phase) ?? anyCycleAttempt;
    const success = lastSuccess.get(phase);
    const fails = recentFails.get(phase) ?? 0;

    // If we have phase-level data for THIS phase, use it exclusively so a
    // successful sibling phase cannot mask a failed one.
    if (lastAttempt.has(phase) || lastSuccess.has(phase)) {
      const force =
        fails > 0 && !success
          ? { force_state: 'failed' as const, force_reason: 'missed_cadence' as const }
          : fails > 0
            ? { force_state: 'degraded' as const, force_reason: 'recent_failures' as const }
            : {};
      out.set(entry.key, {
        last_attempt_at: attempt ?? null,
        last_success_at: success ?? null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: fails,
        ...force,
      });
      continue;
    }

    // No per-phase detail: fall back to cycle-level success as a weak signal
    // for core phases only. Required pack-gated phases without phase detail
    // stay unknown rather than inheriting cycle health (R25 / AE8).
    const isCore = ['sync', 'extract', 'extract_facts', 'embed', 'orphans', 'lint', 'backlinks'].includes(phase);
    if (isCore && anyCycleSuccess) {
      out.set(entry.key, {
        last_attempt_at: anyCycleAttempt,
        last_success_at: anyCycleSuccess,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: 0,
      });
    } else if (anyCycleAttempt) {
      out.set(entry.key, {
        last_attempt_at: anyCycleAttempt,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: 0,
        force_state: 'unknown',
        force_reason: 'evidence_unavailable',
      });
    } else {
      out.set(entry.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: 0,
        force_state: 'unknown',
        force_reason: 'evidence_unavailable',
      });
    }
  }

  return out;
}
