/** Behavior-preserving primitives shared by operational evidence collectors. */

import type {
  ExpectedWorkEntry,
  WorkEvidence,
} from '../types.ts';
import type { ReasonCode } from '../reason-codes.ts';

type UnavailableReason = Extract<
  ReasonCode,
  'db_unreachable' | 'evidence_unavailable' | 'collector_timeout' | 'instrumentation_missing'
>;

export interface UnavailableEvidenceOptions {
  backlog_items?: number | null;
  recent_failures?: number | null;
}

export interface SourceScopeOptions {
  sourceId?: string;
  sourceIds?: string[];
}

/** Resolve the canonical source grant without widening an explicit empty grant. */
export function sourceIdsForScope(
  scope: SourceScopeOptions,
): string[] | undefined {
  if (scope.sourceIds !== undefined) return [...new Set(scope.sourceIds)];
  if (scope.sourceId !== undefined) return [scope.sourceId];
  return undefined;
}

export function unavailableEvidence(
  reason: UnavailableReason,
  options: UnavailableEvidenceOptions = {},
): WorkEvidence {
  return {
    last_attempt_at: null,
    last_success_at: null,
    backlog_items: options.backlog_items ?? null,
    oldest_pending_age_seconds: null,
    recent_failures: options.recent_failures ?? null,
    force_state: 'unknown',
    force_reason: reason,
  };
}

export function unavailableEvidenceMap(
  entries: readonly ExpectedWorkEntry[],
  reason: UnavailableReason,
  options: UnavailableEvidenceOptions = {},
): Map<string, WorkEvidence | null> {
  return new Map(
    entries.map((entry) => [entry.key, unavailableEvidence(reason, options)]),
  );
}

export function toIsoTimestamp(
  value: string | Date | null | undefined,
): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Preserve collectors whose prior contract rejected malformed DB timestamps. */
export function toIsoTimestampStrict(
  value: string | Date | null | undefined,
): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

export function newestIso(
  values: readonly (string | null | undefined)[],
): string | null {
  let newest: string | null = null;
  for (const value of values) {
    if (value && (!newest || value > newest)) newest = value;
  }
  return newest;
}

export function finiteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
