import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../../src/core/engine.ts';
import {
  buildExpectedWorkRegistry,
  dreamPhaseWorkKey,
  minionWorkKey,
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
    expect(classifyDreamSkipReason('source_in_cooldown')).toBe('deferred');
    expect(classifyDreamSkipReason('lock_busy')).toBe('deferred');
    expect(classifyDreamSkipReason('no_brain_dir')).toBe('failure');
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

describe('generic fact and link evidence', () => {
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
