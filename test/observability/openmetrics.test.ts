/**
 * OpenMetrics exposition contract (U4).
 */
import { describe, test, expect } from 'bun:test';
import { renderOpenMetrics, scanOpenMetricsForProhibited } from '../../src/core/observability/openmetrics.ts';
import type { OperationalSnapshot } from '../../src/core/observability/types.ts';

function snap(partial?: Partial<OperationalSnapshot>): OperationalSnapshot {
  return {
    schema_version: 1,
    brain: 'personal',
    generated_at: '2026-07-23T12:00:00.000Z',
    state: 'degraded',
    items: [
      {
        key: 'minion.autopilot-cycle',
        kind: 'minion',
        state: 'failed',
        last_attempt_at: '2026-07-23T10:00:00.000Z',
        last_success_at: '2026-07-22T10:00:00.000Z',
        next_due_at: '2026-07-22T11:00:00.000Z',
        backlog_items: 2,
        oldest_pending_age_seconds: 4000,
        recent_failures: 1,
        reason: 'missed_cadence',
        repair_runbook: 'missed-work',
        required: true,
        enabled: true,
      },
    ],
    build: { channel: 'fork', tag: '0.42.0.0', sha: 'abc1234', managed_fork: true },
    ...partial,
  };
}

describe('renderOpenMetrics', () => {
  test('emits bounded metric families and one-hot states', () => {
    const text = renderOpenMetrics(snap());
    expect(text).toContain('gbrain_observer_info{');
    expect(text).toContain('gbrain_observer_snapshot_timestamp_seconds{');
    expect(text).toContain('gbrain_brain_state{brain="personal",state="degraded"} 1');
    expect(text).toContain('gbrain_brain_state{brain="personal",state="healthy"} 0');
    expect(text).toContain('gbrain_expected_work_state{brain="personal",work="minion.autopilot-cycle",state="failed"} 1');
    expect(text).toContain(
      'gbrain_expected_work_info{brain="personal",work="minion.autopilot-cycle",kind="minion",required="true",enabled="true",runbook="missed-work",version="none"} 1',
    );
    expect(text).toContain('gbrain_expected_work_backlog_items{');
    expect(text).toContain('gbrain_expected_work_reason{');
    expect(text).toContain('# EOF');
  });

  test('rejects invalid work keys', () => {
    expect(() =>
      renderOpenMetrics(snap({
        items: [{
          key: 'bad key with spaces',
          kind: 'minion',
          state: 'healthy',
          last_attempt_at: null,
          last_success_at: null,
          next_due_at: null,
          backlog_items: null,
          oldest_pending_age_seconds: null,
          recent_failures: null,
          reason: null,
          repair_runbook: null,
          required: true,
          enabled: true,
        }],
      })),
    ).toThrow(/invalid work/);
  });

  test('rejects unbounded metadata labels', () => {
    const invalidKind = snap();
    invalidKind.items[0]!.kind = 'secret kind' as never;
    expect(() => renderOpenMetrics(invalidKind)).toThrow(/invalid kind/);

    const invalidRunbook = snap();
    invalidRunbook.items[0]!.repair_runbook = 'https://internal.example/runbook?token=secret';
    expect(() => renderOpenMetrics(invalidRunbook)).toThrow(/invalid runbook/);
  });

  test('content scan catches database URLs', () => {
    const hits = scanOpenMetricsForProhibited('postgres://user:pass@host/db');
    expect(hits).toContain('database_url');
    expect(scanOpenMetricsForProhibited(renderOpenMetrics(snap()))).toEqual([]);
  });
});
