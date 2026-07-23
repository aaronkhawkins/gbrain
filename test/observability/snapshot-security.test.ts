import { describe, expect, test } from 'bun:test';
import { collectAllEvidence } from '../../src/core/observability/collectors/index.ts';
import {
  buildOperationalSnapshot,
  buildReadOnlyOperationalSnapshot,
  serializeOperationalSnapshot,
} from '../../src/core/observability/snapshot.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import type {
  ExpectedWorkEntry,
  WorkEvidence,
} from '../../src/core/observability/types.ts';

const dbWork: ExpectedWorkEntry = {
  key: 'minion.daily',
  kind: 'minion',
  enabled: true,
  required: true,
  criticality: 'required',
  cadence_seconds: 86_400,
  grace_seconds: 3_600,
  evidence_adapter: 'minion_job',
  selector: 'daily',
  repair_runbook: 'missed-work',
};

const runtimeWork: ExpectedWorkEntry = {
  key: 'runtime.supervisor',
  kind: 'local_runtime',
  enabled: true,
  required: false,
  criticality: 'optional',
  cadence_seconds: null,
  grace_seconds: 0,
  evidence_adapter: 'local_runtime',
  selector: 'supervisor',
  repair_runbook: 'observer-missing',
};

const healthy: WorkEvidence = {
  last_attempt_at: '2026-07-23T12:00:00.000Z',
  last_success_at: '2026-07-23T12:00:00.000Z',
  backlog_items: 0,
  oldest_pending_age_seconds: null,
  recent_failures: 0,
  force_state: 'healthy',
  force_reason: 'ok',
};

describe('operational snapshot security posture', () => {
  test('schema incompatibility overrides DB-backed evidence but not local runtime', async () => {
    const snapshot = await buildOperationalSnapshot({
      engine: null,
      registry: [dbWork, runtimeWork],
      evidenceByKey: new Map([
        [dbWork.key, healthy],
        [runtimeWork.key, healthy],
      ]),
      schemaCompatible: false,
      now: new Date('2026-07-23T12:00:00.000Z'),
      brainId: 'schema_test',
    });

    expect(snapshot.items.find((item) => item.key === dbWork.key)).toMatchObject({
      state: 'unknown',
      reason: 'schema_incompatible',
    });
    expect(snapshot.items.find((item) => item.key === runtimeWork.key)).toMatchObject({
      state: 'healthy',
      reason: 'ok',
    });
    expect(snapshot.state).toBe('unknown');
  });

  test('collector failures export bounded warning codes, never raw errors', async () => {
    const secret = 'postgres://user:password@private-host/brain';
    const result = await collectAllEvidence({
      engine: {} as never,
      registry: [dbWork],
      adapters: {
        minion_job: async () => {
          throw new Error(secret);
        },
      },
    });

    expect(result.warnings).toEqual(['collector_failed']);
    expect(JSON.stringify(result)).not.toContain(secret);

    const snapshot = await buildOperationalSnapshot({
      engine: null,
      registry: [dbWork],
      evidenceByKey: result.evidence,
      now: new Date('2026-07-23T12:00:00.000Z'),
      brainId: 'warning_test',
    });
    snapshot.warnings = result.warnings;
    expect(serializeOperationalSnapshot(snapshot)).not.toContain(secret);
  });

  test('a schema newer than this runtime is incompatible', async () => {
    const snapshot = await buildReadOnlyOperationalSnapshot({
      engine: {
        kind: 'pglite',
        getConfig: async (key: string) =>
          key === 'version' ? String(LATEST_VERSION + 1) : null,
        executeRaw: async () => [],
      } as never,
      registry: [dbWork],
      evidenceByKey: new Map([[dbWork.key, healthy]]),
      now: new Date('2026-07-23T12:00:00.000Z'),
      brainId: 'ahead_schema',
    });

    expect(snapshot.items[0]).toMatchObject({
      state: 'unknown',
      reason: 'schema_incompatible',
    });
  });
});
