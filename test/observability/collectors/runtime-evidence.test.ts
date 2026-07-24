import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../../src/core/engine.ts';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import {
  buildExpectedWorkRegistry,
  dreamPhaseWorkKey,
  minionWorkKey,
  nativeIntakeWorkKey,
} from '../../../src/core/observability/expected-work.ts';
import { collectDreamPhaseEvidence } from '../../../src/core/observability/collectors/dream-phase.ts';
import { collectMinionJobEvidence } from '../../../src/core/observability/collectors/minion-job.ts';
import { collectFactEvidence } from '../../../src/core/observability/collectors/facts.ts';
import { collectLinkEvidence } from '../../../src/core/observability/collectors/links.ts';
import { collectExtractRollupEvidence } from '../../../src/core/observability/collectors/extract-rollup.ts';
import { classifyDreamSkipReason } from '../../../src/core/observability/collectors/dream-phase.ts';
import { withObserverReadOnlyEngine } from '../../../src/core/observability/read-only-engine.ts';

const NOW = new Date('2026-07-23T12:00:00.000Z');
const SOURCE_LABEL_KEY = 'test-brain-source-label-key';

function engineWithRows(rows: unknown[], onSql?: (sql: string) => void): BrainEngine {
  return {
    executeRaw: async (sql: string) => {
      onSql?.(sql);
      return rows;
    },
  } as unknown as BrainEngine;
}

describe('Dream evidence scope and skip classification', () => {
  test('distinguishes no-op, deferred, and failed skips', () => {
    expect(classifyDreamSkipReason('no_work')).toBe('success');
    expect(classifyDreamSkipReason('insufficient_evidence')).toBe('success');
    expect(classifyDreamSkipReason('cooldown_active')).toBe('success');
    expect(classifyDreamSkipReason('source_in_cooldown')).toBe('deferred');
    expect(classifyDreamSkipReason('lock_busy')).toBe('deferred');
    expect(classifyDreamSkipReason('no_brain_dir')).toBe('failure');
  });

  test('a warning proves the phase ran without creating a cadence failure', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: ['lint'],
      includeInfrastructure: false,
    }).find((candidate) =>
      candidate.key === dreamPhaseWorkKey('lint', 'alpha', SOURCE_LABEL_KEY)
    )!;
    const finishedAt = '2026-07-23T11:05:00.000Z';
    const evidence = await collectDreamPhaseEvidence([entry], engineWithRows([{
      name: 'autopilot-cycle',
      status: 'completed',
      started_at: '2026-07-23T11:00:00.000Z',
      finished_at: finishedAt,
      data: { source_id: 'alpha' },
      result: {
        report: {
          phases: [{
            phase: 'lint',
            status: 'warn',
            details: { issues: 2 },
          }],
        },
      },
    }]), { now: NOW });

    expect(evidence.get(entry.key)).toEqual(expect.objectContaining({
      last_attempt_at: finishedAt,
      last_success_at: finishedAt,
      recent_failures: 0,
    }));
    expect(evidence.get(entry.key)?.force_state).toBeUndefined();
  });

  test('insufficient evidence is a successful scheduled no-op', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: ['patterns'],
      includeInfrastructure: false,
    }).find((candidate) =>
      candidate.key === dreamPhaseWorkKey('patterns', 'alpha', SOURCE_LABEL_KEY)
    )!;
    const finishedAt = '2026-07-23T11:05:00.000Z';
    const evidence = await collectDreamPhaseEvidence([entry], engineWithRows([{
      name: 'autopilot-cycle',
      status: 'completed',
      started_at: '2026-07-23T11:00:00.000Z',
      finished_at: finishedAt,
      data: { source_id: 'alpha' },
      result: {
        report: {
          phases: [{
            phase: 'patterns',
            status: 'skipped',
            details: { reason: 'insufficient_evidence' },
          }],
        },
      },
    }]), { now: NOW });

    expect(evidence.get(entry.key)).toEqual(expect.objectContaining({
      last_success_at: finishedAt,
      recent_failures: 0,
    }));
  });

  test('source-scoped outcomes cannot mask another source and benign no-work is successful', async () => {
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: ['extract_atoms', 'embed'],
      includeInfrastructure: false,
    });
    const entries = registry.filter((e) => e.kind === 'dream_phase');
    const rows = [
      {
        name: 'autopilot-cycle',
        status: 'completed',
        started_at: '2026-07-23T11:00:00.000Z',
        finished_at: '2026-07-23T11:05:00.000Z',
        data: { source_id: 'alpha' },
        result: {
          report: {
            phases: [{
              phase: 'extract_atoms',
              status: 'skipped',
              details: { reason: 'no_work' },
            }],
          },
        },
      },
      {
        name: 'autopilot-cycle',
        status: 'completed',
        started_at: '2026-07-23T11:10:00.000Z',
        finished_at: '2026-07-23T11:15:00.000Z',
        data: { source_id: 'beta' },
        result: {
          report: {
            phases: [{
              phase: 'extract_atoms',
              status: 'skipped',
              details: { reason: 'no_brain_dir' },
            }],
          },
        },
      },
      {
        name: 'autopilot-global-maintenance',
        status: 'completed',
        started_at: '2026-07-23T11:20:00.000Z',
        finished_at: '2026-07-23T11:25:00.000Z',
        data: {},
        result: {
          report: { phases: [{ phase: 'embed', status: 'ok' }] },
        },
      },
    ];
    const evidence = await collectDreamPhaseEvidence(entries, engineWithRows(rows), { now: NOW });

    expect(evidence.get(dreamPhaseWorkKey('extract_atoms', 'alpha', SOURCE_LABEL_KEY))).toMatchObject({
      last_success_at: '2026-07-23T11:05:00.000Z',
      recent_failures: 0,
    });
    expect(evidence.get(dreamPhaseWorkKey('extract_atoms', 'beta', SOURCE_LABEL_KEY))).toMatchObject({
      last_success_at: null,
      recent_failures: 1,
      force_state: 'failed',
    });
    expect(evidence.get(dreamPhaseWorkKey('embed'))).toMatchObject({
      last_success_at: '2026-07-23T11:25:00.000Z',
    });
  });

  test('an unscoped legacy cycle satisfies the scheduler fallback Dream entry', async () => {
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['default'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      scheduledSourceIds: [],
      enabledDreamPhases: ['sync'],
      includeInfrastructure: false,
    });
    const entry = registry.find((candidate) =>
      candidate.kind === 'dream_phase' && candidate.selector === 'sync'
    )!;
    const evidence = await collectDreamPhaseEvidence([entry], engineWithRows([{
      name: 'autopilot-cycle',
      status: 'completed',
      started_at: '2026-07-23T11:00:00.000Z',
      finished_at: '2026-07-23T11:05:00.000Z',
      data: {},
      result: {},
    }]), { now: NOW });

    expect(entry.scope).toEqual({ type: 'global' });
    expect(evidence.get(entry.key)).toMatchObject({
      last_success_at: '2026-07-23T11:05:00.000Z',
      recent_failures: 0,
    });
  });

  test('sync lock contention uses the runtime syncStatus shape and remains deferred', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: ['sync'],
      includeInfrastructure: false,
    }).find((candidate) =>
      candidate.key === dreamPhaseWorkKey('sync', 'alpha', SOURCE_LABEL_KEY)
    )!;
    const evidence = await collectDreamPhaseEvidence([entry], engineWithRows([{
      name: 'autopilot-cycle',
      status: 'completed',
      started_at: '2026-07-23T11:00:00.000Z',
      finished_at: '2026-07-23T11:05:00.000Z',
      data: { source_id: 'alpha' },
      result: {
        report: {
          phases: [{
            phase: 'sync',
            status: 'skipped',
            details: { syncStatus: 'lock_busy' },
          }],
        },
      },
    }]), { now: NOW });

    expect(evidence.get(entry.key)).toMatchObject({
      last_attempt_at: '2026-07-23T11:05:00.000Z',
      last_success_at: null,
      recent_failures: 0,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    });
  });
});

describe('Minion evidence recovery and bounded history', () => {
  test('a later success supersedes an old dead attempt', async () => {
    const capturedSql: string[] = [];
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((e) => e.key === minionWorkKey('autopilot-cycle', 'alpha', SOURCE_LABEL_KEY))!;
    const engine = engineWithRows([
      {
        name: 'autopilot-cycle',
        status: 'completed',
        created_at: '2026-07-23T11:00:00.000Z',
        started_at: '2026-07-23T11:01:00.000Z',
        finished_at: '2026-07-23T11:10:00.000Z',
        updated_at: '2026-07-23T11:10:00.000Z',
        data: { source_id: 'alpha' },
      },
      {
        name: 'autopilot-cycle',
        status: 'dead',
        created_at: '2026-07-22T11:00:00.000Z',
        started_at: '2026-07-22T11:01:00.000Z',
        finished_at: '2026-07-22T11:10:00.000Z',
        updated_at: '2026-07-22T11:10:00.000Z',
        data: { source_id: 'alpha' },
      },
    ], (sql) => { capturedSql.push(sql); });

    const evidence = await collectMinionJobEvidence([entry], engine, { now: NOW });
    expect(evidence.get(entry.key)).toMatchObject({
      last_success_at: '2026-07-23T11:10:00.000Z',
      recent_failures: 0,
      backlog_items: 0,
    });
    expect(evidence.get(entry.key)?.force_state).toBeUndefined();
    expect(capturedSql.join('\n')).toContain('CROSS JOIN LATERAL');
    expect(capturedSql.join('\n')).toContain('LIMIT 100');
    expect(capturedSql.join('\n')).toContain(
      'COALESCE(finished_at, started_at, updated_at, created_at) DESC, id DESC',
    );
  });

  test('strict read-only facade accepts batched attempts and aggregated backlog rows', async () => {
    const capturedSql: string[] = [];
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((candidate) =>
      candidate.key === minionWorkKey('autopilot-cycle', 'alpha', SOURCE_LABEL_KEY)
    )!;
    const engine = {
      kind: 'pglite',
      getConfig: async () => null,
      executeRaw: async (sql: string) => {
        capturedSql.push(sql);
        if (sql.includes('CROSS JOIN LATERAL')) {
          return [{
            name: 'autopilot-cycle',
            status: 'completed',
            created_at: '2026-07-23T10:00:00.000Z',
            started_at: '2026-07-23T10:01:00.000Z',
            finished_at: '2026-07-23T10:10:00.000Z',
            updated_at: '2026-07-23T10:10:00.000Z',
            data: { source_id: 'alpha' },
          }];
        }
        return [{
          name: 'autopilot-cycle',
          source_id: 'alpha',
          backlog_count: '100000',
          oldest_created_at: '2026-07-23T09:00:00.000Z',
        }];
      },
    } as unknown as BrainEngine;

    const evidence = await withObserverReadOnlyEngine(engine, (readonlyEngine) =>
      collectMinionJobEvidence([entry], readonlyEngine, { now: NOW }));

    expect(capturedSql).toHaveLength(2);
    expect(capturedSql.every((sql) => sql.trimStart().startsWith('SELECT'))).toBe(true);
    expect(capturedSql.some((sql) => /WHERE name = \$1/.test(sql))).toBe(false);
    expect(capturedSql[1]).toContain('COUNT(*)');
    expect(capturedSql[1]).not.toContain('SELECT name, data, status');
    expect(evidence.get(entry.key)).toMatchObject({
      backlog_items: 100000,
      oldest_pending_age_seconds: 10800,
    });
  });
});

describe('native-intake Minion operational truth', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;
  let entry: ReturnType<typeof buildExpectedWorkRegistry>[number];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
    entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      nativeIntakeTargetIds: ['alpha'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((candidate) =>
      candidate.key === nativeIntakeWorkKey('alpha', SOURCE_LABEL_KEY)
    )!;
  }, 30_000);

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('an idle event-driven intake is healthy when all evidence queries succeed', async () => {
    const evidence = await collectMinionJobEvidence([entry], engine, { now: NOW });

    expect(evidence.get(entry.key)).toEqual({
      last_attempt_at: null,
      last_success_at: null,
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
    });
  });

  test('waiting, active, and delayed intake report backlog count and oldest age', async () => {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, created_at)
       VALUES
         ('ingest_capture', 'waiting', '{"sourceId":"alpha"}'::jsonb, '2026-07-23T10:00:00.000Z'),
         ('ingest_capture', 'active',  '{"sourceId":"alpha"}'::jsonb, '2026-07-23T11:00:00.000Z'),
         ('ingest_capture', 'delayed', '{"sourceId":"alpha"}'::jsonb, '2026-07-23T11:30:00.000Z')`,
    );

    const evidence = await collectMinionJobEvidence([entry], engine, { now: NOW });

    expect(evidence.get(entry.key)).toMatchObject({
      backlog_items: 3,
      oldest_pending_age_seconds: 7200,
      recent_failures: 0,
      force_state: 'degraded',
      force_reason: 'stalled',
    });
  });

  test('old unresolved dead work survives newer success, 24 hours, and the newest 100 attempts', async () => {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, created_at, finished_at)
       VALUES (
         'ingest_capture',
         'dead',
         '{"sourceId":"alpha"}'::jsonb,
         '2026-07-20T11:00:00.000Z',
         '2026-07-20T11:05:00.000Z'
       )`,
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, created_at, finished_at)
       SELECT
         'ingest_capture',
         'completed',
         '{"sourceId":"alpha"}'::jsonb,
         '2026-07-23T11:00:00.000Z'::timestamptz + (n * interval '1 second'),
         '2026-07-23T11:00:00.000Z'::timestamptz + (n * interval '1 second')
       FROM generate_series(1, 101) AS n`,
    );

    const evidence = await collectMinionJobEvidence([entry], engine, { now: NOW });

    expect(evidence.get(entry.key)).toMatchObject({
      last_success_at: '2026-07-23T11:01:41.000Z',
      recent_failures: 1,
      backlog_items: 0,
      force_state: 'failed',
      force_reason: 'dead',
    });
  });

  test('one target old dead row is not hidden by more than 100 newer attempts from another target', async () => {
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      nativeIntakeTargetIds: ['alpha', 'beta'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    });
    const entries = registry.filter((candidate) => candidate.selector === 'ingest_capture');
    const alpha = entries.find((candidate) =>
      candidate.key === nativeIntakeWorkKey('alpha', SOURCE_LABEL_KEY)
    )!;
    const beta = entries.find((candidate) =>
      candidate.key === nativeIntakeWorkKey('beta', SOURCE_LABEL_KEY)
    )!;
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, created_at, finished_at)
       VALUES (
         'ingest_capture',
         'dead',
         '{"sourceId":"alpha"}'::jsonb,
         '2026-07-20T11:00:00.000Z',
         '2026-07-20T11:05:00.000Z'
       )`,
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, created_at, finished_at)
       SELECT
         'ingest_capture',
         'completed',
         '{"sourceId":"beta"}'::jsonb,
         '2026-07-23T11:00:00.000Z'::timestamptz + (n * interval '1 second'),
         '2026-07-23T11:00:00.000Z'::timestamptz + (n * interval '1 second')
       FROM generate_series(1, 101) AS n`,
    );

    const evidence = await collectMinionJobEvidence(entries, engine, { now: NOW });

    expect(evidence.get(alpha.key)).toMatchObject({
      last_attempt_at: null,
      last_success_at: null,
      recent_failures: 1,
      backlog_items: 0,
      force_state: 'failed',
      force_reason: 'dead',
    });
    expect(evidence.get(beta.key)).toMatchObject({
      recent_failures: 0,
      backlog_items: 0,
    });
    expect(evidence.get(beta.key)?.force_state).toBeUndefined();
  });

  test('retry completion clears only its own unresolved failure', async () => {
    const first = await queue.add(
      'ingest_capture',
      { sourceId: 'alpha' },
      { remove_on_complete: false, remove_on_fail: false },
      { allowProtectedSubmit: true },
    );
    const second = await queue.add(
      'ingest_capture',
      { sourceId: 'alpha' },
      { remove_on_complete: false, remove_on_fail: false },
      { allowProtectedSubmit: true },
    );
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET status = CASE WHEN id = $1 THEN 'dead' ELSE 'failed' END,
              finished_at = now(),
              updated_at = now()
        WHERE id = ANY($2::int[])`,
      [first.id, [first.id, second.id]],
    );

    const bothFailed = await collectMinionJobEvidence([entry], engine, { now: NOW });
    expect(bothFailed.get(entry.key)).toMatchObject({
      recent_failures: 2,
      force_state: 'failed',
      force_reason: 'dead',
    });

    expect(await queue.retryJob(first.id)).not.toBeNull();
    const claimed = await queue.claim('retry-token', 60_000, 'default', ['ingest_capture']);
    expect(claimed?.id).toBe(first.id);
    expect(await queue.completeJob(first.id, 'retry-token')).not.toBeNull();

    const oneFailed = await collectMinionJobEvidence([entry], engine, { now: NOW });
    expect(oneFailed.get(entry.key)).toMatchObject({
      recent_failures: 1,
      force_state: 'degraded',
      force_reason: 'recent_failures',
    });

    expect(await queue.retryJob(second.id)).not.toBeNull();
    const claimedSecond = await queue.claim('retry-token-2', 60_000, 'default', ['ingest_capture']);
    expect(claimedSecond?.id).toBe(second.id);
    expect(await queue.completeJob(second.id, 'retry-token-2')).not.toBeNull();

    const recovered = await collectMinionJobEvidence([entry], engine, { now: NOW });
    expect(recovered.get(entry.key)).toMatchObject({
      recent_failures: 0,
      backlog_items: 0,
    });
    expect(recovered.get(entry.key)?.force_state).toBeUndefined();
  });
});

describe('generic fact and link evidence', () => {
  test('remote grants constrain every source-backed runtime query', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const engine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return [];
      },
    } as unknown as BrainEngine;
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: ['sync'],
      includeInfrastructure: false,
      observability: {
        external_work: [{
          key: 'processor.entities.alpha',
          kind: 'content_processor',
          evidence: {
            adapter: 'extract_rollup',
            selector: 'entity-extractor',
            source_id: 'alpha',
          },
        }],
      },
    });
    const opts = { now: NOW, sourceIds: ['alpha'] };

    await collectDreamPhaseEvidence(
      registry.filter((entry) => entry.evidence_adapter === 'dream_phase'),
      engine,
      opts,
    );
    await collectMinionJobEvidence(
      registry.filter((entry) => entry.evidence_adapter === 'minion_job'),
      engine,
      opts,
    );
    await collectExtractRollupEvidence(
      registry.filter((entry) => entry.evidence_adapter === 'extract_rollup'),
      engine,
      opts,
    );

    expect(calls).toHaveLength(4);
    expect(calls[0]?.sql).toContain(
      `COALESCE(data->>'source_id', data->>'sourceId') = ANY($1::text[])`,
    );
    expect(calls[0]?.params).toEqual([['alpha']]);
    for (const call of calls.slice(1, 3)) {
      expect(call.sql).toContain(
        `COALESCE(data->>'source_id', data->>'sourceId') = ANY($2::text[])`,
      );
      expect(call.params?.[1]).toEqual(['alpha']);
    }
    expect(calls[3]?.sql).toContain('source_id = ANY($2::text[])');
    expect(calls[3]?.params?.[1]).toEqual(['alpha']);
  });

  test('facts use the engine-owned pending-fact counter', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((e) => e.selector === 'wiki' && e.kind === 'fact')!;
    const engine = {
      countUnconsolidatedFacts: async (sourceId: string) => sourceId === 'wiki' ? 7 : 0,
    } as unknown as BrainEngine;
    const evidence = await collectFactEvidence([entry], engine, { now: NOW });
    expect(evidence.get(entry.key)).toMatchObject({ backlog_items: 7, recent_failures: 0 });
  });

  test('links use the engine-owned extraction watermark counter', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((e) => e.selector === 'wiki' && e.kind === 'link')!;
    const engine = {
      countStalePagesForExtraction: async (opts: { sourceId?: string }) =>
        opts.sourceId === 'wiki' ? 3 : 0,
    } as unknown as BrainEngine;
    const evidence = await collectLinkEvidence([entry], engine, { now: NOW });
    expect(evidence.get(entry.key)).toMatchObject({ backlog_items: 3, recent_failures: 0 });
  });

  test('declared content processors use the durable extraction rollup', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
      observability: {
        external_work: [{
          key: 'processor.entities.wiki',
          kind: 'content_processor',
          required: true,
          cadence_seconds: 3600,
          evidence: {
            adapter: 'extract_rollup',
            selector: 'entity-extractor',
            source_id: 'wiki',
          },
        }],
      },
    }).find((candidate) => candidate.key === 'processor.entities.wiki')!;
    const engine = engineWithRows([{
      kind: 'entity-extractor',
      source_id: 'wiki',
      last_attempt: '2026-07-23T11:40:00.000Z',
      last_success: '2026-07-23T11:40:00.000Z',
      failures: 0,
    }]);

    const evidence = await collectExtractRollupEvidence([entry], engine, { now: NOW });
    expect(evidence.get(entry.key)).toMatchObject({
      last_attempt_at: '2026-07-23T11:40:00.000Z',
      last_success_at: '2026-07-23T11:40:00.000Z',
      recent_failures: 0,
    });
  });
});
