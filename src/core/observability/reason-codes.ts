/**
 * Bounded reason codes for operational observations.
 * Dashboards and alerts may only use members of this set.
 */

export const REASON_CODES = [
  'ok',
  'within_grace',
  'missed_cadence',
  'recent_failures',
  'backlog_warn',
  'backlog_fail',
  'stalled',
  'dead',
  'embedding_mismatch',
  'embedding_disabled',
  'schema_incompatible',
  'evidence_unavailable',
  'evidence_stale',
  'instrumentation_missing',
  'collector_timeout',
  'db_unreachable',
  'disabled',
  'not_due',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_SET: ReadonlySet<string> = new Set(REASON_CODES);

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && REASON_SET.has(value);
}

/** Map reason → runbook slug under docs/runbooks/observability/. */
export function defaultRunbookForReason(reason: ReasonCode | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'missed_cadence':
    case 'recent_failures':
    case 'stalled':
    case 'dead':
      return 'missed-work';
    case 'backlog_warn':
    case 'backlog_fail':
      return 'backlog';
    case 'embedding_mismatch':
    case 'embedding_disabled':
      return 'embedding';
    case 'evidence_unavailable':
    case 'evidence_stale':
    case 'collector_timeout':
    case 'db_unreachable':
    case 'schema_incompatible':
      return 'observer-missing';
    case 'instrumentation_missing':
      return 'missed-work';
    default:
      return null;
  }
}
