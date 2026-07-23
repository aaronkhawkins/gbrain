/**
 * Brain rollup semantics (U1).
 */
import { describe, test, expect } from 'bun:test';
import { rollupBrainState, stateSeverity } from '../../src/core/observability/rollup.ts';
import type { WorkObservation } from '../../src/core/observability/types.ts';

function item(partial: Partial<WorkObservation> & Pick<WorkObservation, 'key' | 'state'>): WorkObservation {
  return {
    kind: 'minion',
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
    ...partial,
  };
}

describe('rollupBrainState', () => {
  test('any required failed yields failed', () => {
    expect(rollupBrainState([
      item({ key: 'a', state: 'healthy' }),
      item({ key: 'b', state: 'failed' }),
    ])).toBe('failed');
  });

  test('required unknown beats degraded', () => {
    expect(rollupBrainState([
      item({ key: 'a', state: 'degraded' }),
      item({ key: 'b', state: 'unknown' }),
    ])).toBe('unknown');
  });

  test('disabled and optional do not force failed rollup', () => {
    expect(rollupBrainState([
      item({ key: 'a', state: 'healthy' }),
      item({ key: 'b', state: 'failed', required: false }),
      item({ key: 'c', state: 'disabled', enabled: false }),
    ])).toBe('healthy');
  });

  test('all required healthy yields healthy', () => {
    expect(rollupBrainState([
      item({ key: 'a', state: 'healthy' }),
      item({ key: 'b', state: 'healthy' }),
    ])).toBe('healthy');
  });

  test('stateSeverity ranks failed worst', () => {
    expect(stateSeverity('failed')).toBeGreaterThan(stateSeverity('unknown'));
    expect(stateSeverity('unknown')).toBeGreaterThan(stateSeverity('degraded'));
    expect(stateSeverity('degraded')).toBeGreaterThan(stateSeverity('healthy'));
  });
});
