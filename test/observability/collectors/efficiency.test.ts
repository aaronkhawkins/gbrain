import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../../src/core/engine.ts';
import {
  buildExpectedWorkRegistry,
} from '../../../src/core/observability/expected-work.ts';
import { collectAllEvidence } from '../../../src/core/observability/collectors/index.ts';
import { collectFactEvidence } from '../../../src/core/observability/collectors/facts.ts';
import { collectLinkEvidence } from '../../../src/core/observability/collectors/links.ts';

const NOW = new Date('2026-07-23T12:00:00.000Z');
const SOURCE_LABEL_KEY = 'test-brain-source-label-key';

describe('observer collector query efficiency', () => {
  test('ingestion and embedding share one source-health computation per snapshot', async () => {
    const calls: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('FROM sources')) {
          return [{
            id: 'alpha',
            name: 'Alpha',
            local_path: null,
            last_commit: null,
            last_sync_at: NOW,
            config: {},
            created_at: NOW,
            archived: false,
            newest_content_at: NOW,
          }];
        }
        if (sql.includes('FROM content_chunks')) {
          return [{ source_id: 'alpha', total: 10, embedded: 10 }];
        }
        if (sql.includes('FROM pages')) {
          return [{ source_id: 'alpha', n: 2 }];
        }
        if (sql.includes('FROM minion_jobs')) return [];
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as BrainEngine;
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: true,
    }).filter((entry) =>
      entry.evidence_adapter === 'ingestion_source' ||
      entry.evidence_adapter === 'embedding');

    const result = await collectAllEvidence({ engine, registry, now: NOW });

    expect(result.partial).toBe(false);
    expect(calls.filter((sql) => sql.includes('FROM sources'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FROM content_chunks'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FROM pages'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FROM minion_jobs'))).toHaveLength(1);
    expect(result.evidence.get('embedding.coverage')).toMatchObject({
      backlog_items: 0,
      force_state: 'healthy',
    });
  });

  test('facts aggregate all source counts in one query and fill absent groups with zero', async () => {
    let calls = 0;
    const engine = {
      executeRaw: async () => {
        calls++;
        return [{ source_id: 'alpha', count: 7 }];
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).filter((entry) => entry.evidence_adapter === 'facts');

    const result = await collectFactEvidence(entries, engine, { now: NOW });

    expect(calls).toBe(1);
    expect(result.get(entries.find((entry) => entry.selector === 'alpha')!.key)?.backlog_items).toBe(7);
    expect(result.get(entries.find((entry) => entry.selector === 'beta')!.key)?.backlog_items).toBe(0);
  });

  test('links aggregate all source counts in one query', async () => {
    let calls = 0;
    const engine = {
      executeRaw: async () => {
        calls++;
        return [
          { source_id: 'alpha', count: 3 },
          { source_id: 'beta', count: 1 },
        ];
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).filter((entry) => entry.evidence_adapter === 'links');

    const result = await collectLinkEvidence(entries, engine, { now: NOW });

    expect(calls).toBe(1);
    expect(result.get(entries.find((entry) => entry.selector === 'alpha')!.key)?.backlog_items).toBe(3);
    expect(result.get(entries.find((entry) => entry.selector === 'beta')!.key)?.backlog_items).toBe(1);
  });

  test('a failed batch falls back to isolated source evidence', async () => {
    const engine = {
      executeRaw: async () => {
        throw new Error('batch unavailable');
      },
      countUnconsolidatedFacts: async (sourceId: string) => {
        if (sourceId === 'beta') throw new Error('source unavailable');
        return 4;
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).filter((entry) => entry.evidence_adapter === 'facts');

    const result = await collectFactEvidence(entries, engine, { now: NOW });

    expect(result.get(entries.find((entry) => entry.selector === 'alpha')!.key)?.backlog_items).toBe(4);
    expect(result.get(entries.find((entry) => entry.selector === 'beta')!.key)).toMatchObject({
      backlog_items: null,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    });
  });
});
