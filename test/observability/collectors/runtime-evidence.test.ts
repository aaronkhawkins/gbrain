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

const NOW = new Date('2026-07-23T12:00:00.000Z');

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

    expect(evidence.get(dreamPhaseWorkKey('extract_atoms', 'alpha'))).toMatchObject({
      last_success_at: '2026-07-23T11:05:00.000Z',
      recent_failures: 0,
    });
    expect(evidence.get(dreamPhaseWorkKey('extract_atoms', 'beta'))).toMatchObject({
      last_success_at: null,
      recent_failures: 1,
      force_state: 'failed',
    });
    expect(evidence.get(dreamPhaseWorkKey('embed'))).toMatchObject({
      last_success_at: '2026-07-23T11:25:00.000Z',
    });
  });
});

describe('Minion evidence recovery and bounded history', () => {
  test('a later success supersedes an old dead attempt', async () => {
    const capturedSql: string[] = [];
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((e) => e.key === minionWorkKey('autopilot-cycle', 'alpha'))!;
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
  });
});

describe('generic fact and link evidence', () => {
  test('facts use the engine-owned pending-fact counter', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((e) => e.key === 'facts.pending.wiki')!;
    const engine = {
      countUnconsolidatedFacts: async (sourceId: string) => sourceId === 'wiki' ? 7 : 0,
    } as unknown as BrainEngine;
    const evidence = await collectFactEvidence([entry], engine, { now: NOW });
    expect(evidence.get(entry.key)).toMatchObject({ backlog_items: 7, recent_failures: 0 });
  });

  test('links use the engine-owned extraction watermark counter', async () => {
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((e) => e.key === 'links.extraction.wiki')!;
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
